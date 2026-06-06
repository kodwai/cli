import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentTrace, TraceTurn } from "./types.js";
import { rateTraceQuality } from "./quality.js";
import { pickPrimaryModel } from "./model.js";

export interface ParsedRollout {
  cwd: string | null;
  /** session_meta.originator — "codex_exec"/"codex" for the CLI, "Codex Desktop" for the app. */
  originator: string | null;
  /** session_meta.thread_source — "user" for genuine user-started sessions; absent on imports. */
  threadSource: string | null;
  turns: TraceTurn[];
  tokenUsage?: { input: number; output: number };
  modelRaw: string | null;
  modelProvider: string | null;
}

/**
 * The Codex desktop app imports other agents' sessions (e.g. Claude Code) into
 * ~/.codex/sessions as rollout files with `originator: "Codex Desktop"` and no
 * `thread_source`, re-stamping their timestamps to import time. Such a rollout
 * keeps the original cwd and would otherwise be mislabeled as a Codex trace.
 * Genuine sessions — CLI (`codex_exec`/`codex`) or a desktop session the user
 * started in a real folder — carry `thread_source: "user"` and are kept.
 */
export function isImportedRollout(parsed: Pick<ParsedRollout, "originator" | "threadSource">): boolean {
  return parsed.originator === "Codex Desktop" && parsed.threadSource !== "user";
}

/**
 * Parse a Codex rollout JSONL file's contents into turns.
 *
 * Each line is `{ timestamp, type, payload }`. We treat `response_item` lines as
 * the canonical conversation (messages + function calls) and read `cwd` from
 * `session_meta` and token usage from `event_msg` `token_count`.
 */
export function parseCodexRollout(content: string): ParsedRollout {
  const turns: TraceTurn[] = [];
  let cwd: string | null = null;
  let originator: string | null = null;
  let threadSource: string | null = null;
  let tokenUsage: { input: number; output: number } | undefined;
  const models: string[] = [];
  let modelProvider: string | null = null;
  // call_id -> tool_call object, so a later function_call_output can fill output.
  const toolCallsById = new Map<string, { name: string; input: string; output: string }>();

  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const payload = rec?.payload;
    if (!payload) continue;

    if (rec.type === "session_meta") {
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.originator === "string") originator = payload.originator;
      if (typeof payload.thread_source === "string") threadSource = payload.thread_source;
      if (typeof payload.model_provider === "string") modelProvider = payload.model_provider;
      continue;
    }

    if (rec.type === "turn_context" && typeof payload.model === "string") {
      models.push(payload.model);
      continue;
    }

    if (rec.type === "event_msg" && payload.type === "token_count") {
      // Real Codex nests cumulative totals under info.total_token_usage; older/
      // assumed shapes put the counts flat on info. Prefer the nested totals,
      // fall back to last_token_usage, then to the flat shape.
      const info = payload.info || payload;
      const usage = info.total_token_usage || info.last_token_usage || info;
      const input = Number(usage.input_tokens ?? usage.input ?? 0) || 0;
      const output = Number(usage.output_tokens ?? usage.output ?? 0) || 0;
      if (input || output) tokenUsage = { input, output };
      continue;
    }

    if (rec.type !== "response_item") continue;

    if (payload.type === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue; // skip developer/system
      const text = extractText(payload.content);
      if (text) turns.push({ role, content: text.slice(0, 2000), timestamp: rec.timestamp });
    } else if (payload.type === "function_call") {
      const args =
        typeof payload.arguments === "string"
          ? payload.arguments
          : JSON.stringify(payload.arguments ?? "");
      const tc = { name: payload.name || "tool", input: args.slice(0, 500), output: "" };
      if (payload.call_id) toolCallsById.set(payload.call_id, tc);
      turns.push({ role: "assistant", content: "[tool use]", timestamp: rec.timestamp, tool_calls: [tc] });
    } else if (payload.type === "function_call_output") {
      const tc = payload.call_id ? toolCallsById.get(payload.call_id) : undefined;
      if (tc) {
        const out =
          typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
        tc.output = out.slice(0, 500);
      }
    }
  }

  return {
    cwd,
    originator,
    threadSource,
    turns,
    tokenUsage,
    modelRaw: pickPrimaryModel(models) ?? null,
    modelProvider,
  };
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (typeof b === "string" ? b : b?.text || ""))
    .join("\n")
    .trim();
}

/** Two-way normalized startsWith match (same rule as cursor.ts). */
export function codexCwdMatches(cwd: string | null, workspacePath: string): boolean {
  if (!cwd) return false;
  const a = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/**
 * Collect a Codex trace from a given sessions root (testable core).
 *
 * Codex stores sessions globally, so we scope to the challenge by matching each
 * session's `cwd` (session_meta) to the workspace and filtering turns to the
 * challenge time window.
 */
export async function collectCodexTraceFrom(
  sessionsRoot: string,
  startTime: Date,
  workspacePath: string,
): Promise<AgentTrace | null> {
  let files: string[];
  try {
    files = await listRolloutFiles(sessionsRoot, startTime);
  } catch {
    return null; // sessions root missing / unreadable
  }
  if (files.length === 0) return null;

  const turns: TraceTurn[] = [];
  let tokenUsage: { input: number; output: number } | undefined;
  let modelRaw: string | null = null;
  let modelProvider: string | null = null;

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseCodexRollout(content);
    if (isImportedRollout(parsed)) continue; // foreign-agent session imported by the desktop app
    if (!codexCwdMatches(parsed.cwd, workspacePath)) continue;

    for (const turn of parsed.turns) {
      if (turn.timestamp) {
        const ts = new Date(turn.timestamp);
        if (!Number.isNaN(ts.getTime()) && ts < startTime) continue;
      }
      turns.push(turn);
    }
    if (parsed.tokenUsage) tokenUsage = parsed.tokenUsage;
    if (parsed.modelRaw) modelRaw = parsed.modelRaw;
    if (parsed.modelProvider) modelProvider = parsed.modelProvider;
  }

  if (turns.length === 0) return null;

  turns.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

  return {
    agent: "codex",
    turns,
    ...(tokenUsage ? { token_usage: tokenUsage } : {}),
    trace_quality: rateTraceQuality(turns),
    ...(modelRaw ? { model_raw: modelRaw } : {}),
    ...(modelProvider ? { model_provider: modelProvider } : {}),
  };
}

/** Recursively collect rollout-*.jsonl files with mtime >= startTime. */
async function listRolloutFiles(sessionsRoot: string, startTime: Date): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          const s = await stat(full);
          if (s.mtime >= startTime) out.push(full);
        } catch {
          // skip unreadable
        }
      }
    }
  }
  await walk(sessionsRoot);
  // Sort lexicographically by full path for deterministic, chronological order:
  // the Codex layout YYYY/MM/DD/rollout-<ISO-timestamp>-<uuid>.jsonl sorts by
  // time under a plain string sort, making token_usage last-wins stable.
  return out.sort();
}

/** Collect a Codex trace for a workspace from the user's ~/.codex/sessions. */
export async function collectCodexTrace(
  startTime: Date,
  workspacePath: string,
): Promise<AgentTrace | null> {
  const sessionsRoot = join(homedir(), ".codex", "sessions");
  return collectCodexTraceFrom(sessionsRoot, startTime, workspacePath);
}
