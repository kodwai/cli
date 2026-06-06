import type { TraceTurn } from "./types.js";

export interface ParsedRollout {
  cwd: string | null;
  turns: TraceTurn[];
  tokenUsage?: { input: number; output: number };
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
  let tokenUsage: { input: number; output: number } | undefined;
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
      continue;
    }

    if (rec.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info || payload;
      const input = Number(info.input_tokens ?? info.input ?? 0) || 0;
      const output = Number(info.output_tokens ?? info.output ?? 0) || 0;
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

  return { cwd, turns, tokenUsage };
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
