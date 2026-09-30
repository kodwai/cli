import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentTrace, TraceTurn } from "./types.js";
import { rateTraceQuality } from "./quality.js";
import { encodeProjectPath } from "./path-encode.js";
import { pickPrimaryModel } from "./model.js";
import { isInjectedUserText } from "./injected.js";
import type { LinkedSession } from "./linked-sessions.js";

/**
 * Collect Claude Code traces scoped to a specific workspace.
 *
 * Claude Code stores sessions under:
 *   ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 *
 * The encoded path replaces every non-alphanumeric character with "-", e.g.:
 *   /Users/joe/my.project → -Users-joe-my-project
 *
 * Each JSONL line has: type ("user"|"assistant"|"system"), message, sessionId, cwd, timestamp
 *
 * Sessions linked to the workspace (by the kodwai plugin's hooks, or by the CLI
 * from CLAUDE_CODE_SESSION_ID) are read from their exact transcript file, which
 * also covers a session started in the folder above the workspace.
 */
export async function collectClaudeCodeTrace(
  startTime: Date,
  workspacePath: string,
  linked: LinkedSession[] = [],
  claudeProjectsDir: string = join(homedir(), ".claude", "projects"),
): Promise<AgentTrace | null> {
  // Keyed by real path: a hook may report the same file through a symlink (/tmp vs /private/tmp).
  const files = new Map<string, string>();
  const add = async (path: string) => files.set(await realpath(path).catch(() => path), path);

  for (const path of await linkedTranscripts(claudeProjectsDir, linked)) await add(path);
  for (const path of await discoverTranscripts(claudeProjectsDir, workspacePath, startTime, files.size > 0)) await add(path);
  if (files.size === 0) return null;

  const turns: TraceTurn[] = [];
  const models: (string | undefined)[] = [];
  for (const file of files.values()) {
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue; // Skip unreadable files
    }
    const parsed = parseClaudeCodeTranscript(content, startTime);
    turns.push(...parsed.turns);
    models.push(...parsed.models);
  }

  if (turns.length === 0) return null;
  // Several files (a linked session plus the workspace's own) interleave by time.
  if (files.size > 1) turns.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

  const claudeModel = pickPrimaryModel(models);
  return {
    agent: "claude-code",
    turns,
    trace_quality: rateTraceQuality(turns),
    ...(claudeModel ? { model_raw: claudeModel } : {}),
  };
}

/** Transcript files of linked sessions: the recorded path, else <projects>/<any>/<session_id>.jsonl. */
async function linkedTranscripts(claudeProjectsDir: string, linked: LinkedSession[]): Promise<string[]> {
  const out: string[] = [];
  let projectDirs: string[] | null = null;
  for (const session of linked) {
    if (session.transcript_path && (await isFile(session.transcript_path))) {
      out.push(session.transcript_path);
      continue;
    }
    if (!/^[A-Za-z0-9-]+$/.test(session.session_id)) continue;
    if (projectDirs === null) {
      try {
        projectDirs = (await readdir(claudeProjectsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => join(claudeProjectsDir, e.name));
      } catch {
        projectDirs = [];
      }
    }
    for (const dir of projectDirs) {
      const candidate = join(dir, `${session.session_id}.jsonl`);
      if (await isFile(candidate)) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}

/**
 * Session files in the workspace's own project folder, modified since the start.
 * The loose suffix match (workspace opened as a subfolder) only runs when no
 * session is linked, since a link is exact.
 */
async function discoverTranscripts(
  claudeProjectsDir: string,
  workspacePath: string,
  startTime: Date,
  haveLinked: boolean,
): Promise<string[]> {
  const encodedPath = encodeProjectPath(workspacePath);

  let allDirs: string[];
  try {
    allDirs = (await readdir(claudeProjectsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // No ~/.claude/projects/ directory
  }

  let projectDirs = allDirs.filter((name) => name === encodedPath);
  if (projectDirs.length === 0 && !haveLinked) {
    // Try partial match — the workspace may be a subdirectory
    const suffix = encodedPath.split("-").slice(-3).join("-");
    projectDirs = allDirs.filter((name) => name.endsWith(suffix));
  }

  const out: string[] = [];
  for (const name of projectDirs) {
    const projectDir = join(claudeProjectsDir, name);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = join(projectDir, entry.name);
      try {
        const s = await stat(filePath);
        if (s.mtime < startTime) continue; // Skip old sessions
      } catch {
        continue;
      }
      out.push(filePath);
    }
  }
  return out;
}

/**
 * Turns from one Claude Code transcript, from `startTime` on. Lines Claude Code
 * injected itself (`isMeta`: skill bodies, command caveats) and other
 * harness-injected text are not the user's words, so they're skipped.
 */
export function parseClaudeCodeTranscript(content: string, startTime: Date): { turns: TraceTurn[]; models: string[] } {
  const turns: TraceTurn[] = [];
  const models: string[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Skip unparseable lines
    }

    // Filter by timestamp — only include messages after startTime
    if (entry.timestamp) {
      const msgTime = new Date(entry.timestamp);
      if (msgTime < startTime) continue;
    }

    if (entry.type === "user") {
      if (entry.isMeta) continue;
      const msg = entry.message;
      if (!msg?.content) continue;
      // Content can be string or array of content blocks
      const text = extractText(msg.content);
      if (text && !isInjectedUserText(text)) {
        turns.push({ role: "user", content: text.slice(0, 2000), timestamp: entry.timestamp });
      }
    } else if (entry.type === "assistant") {
      const msg = entry.message;
      if (msg?.model) models.push(msg.model);
      if (!msg?.content) continue;
      const text = extractText(msg.content);
      const toolCalls = extractToolCalls(msg.content);
      if (text || toolCalls) {
        turns.push({
          role: "assistant",
          content: (text || "[tool use only]").slice(0, 2000),
          timestamp: entry.timestamp,
          tool_calls: toolCalls,
        });
      }
    }
  }

  return { turns, models };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Extract text from Anthropic API message content (string or content blocks array).
 */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text || "")
    .join("\n")
    .trim();
}

/**
 * Extract tool calls from content blocks.
 */
function extractToolCalls(content: any): { name: string; input: string; output: string }[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const calls = content
    .filter((block: any) => block.type === "tool_use")
    .map((block: any) => ({
      name: block.name || "unknown",
      input: (typeof block.input === "string" ? block.input : JSON.stringify(block.input || "")).slice(0, 500),
      output: "", // Output comes in subsequent tool_result messages
    }));

  return calls.length > 0 ? calls : undefined;
}
