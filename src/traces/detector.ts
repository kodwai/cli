import { collectClaudeCodeTrace } from "./claude-code.js";
import { collectCursorTrace } from "./cursor.js";
import { collectCodexTrace } from "./codex.js";
import { readLinkedSessions } from "./linked-sessions.js";
import type { AgentDetection } from "./types.js";

export type AgentChoice = "claude-code" | "cursor" | "codex";

/**
 * Collect the chosen agent's trace for this workspace. Sessions linked to the
 * workspace (.kodwai/agent-sessions.json, written by the kodwai plugin's hooks
 * or by the CLI inside an agent) are read from their exact transcript; the
 * folder-based discovery still runs alongside for sessions nothing linked.
 */
export async function detectAndCollectTrace(
  agentChoice: AgentChoice,
  startTime: Date,
  workspacePath: string,
): Promise<AgentDetection> {
  const linked = await readLinkedSessions(workspacePath, agentChoice);
  const linkedCount = linked.length;

  if (agentChoice === "claude-code") {
    const trace = await collectClaudeCodeTrace(startTime, workspacePath, linked);
    if (trace) {
      return { agent: "claude-code", confidence: "high", trace, linked_sessions: linkedCount };
    }
    return { agent: "claude-code", confidence: "low", trace: null, linked_sessions: linkedCount };
  }

  if (agentChoice === "cursor") {
    const trace = await collectCursorTrace(startTime, workspacePath, linked);
    if (trace) {
      return { agent: "cursor", confidence: linkedCount ? "high" : "medium", trace, linked_sessions: linkedCount };
    }
    return { agent: "cursor", confidence: "low", trace: null, linked_sessions: linkedCount };
  }

  if (agentChoice === "codex") {
    const trace = await collectCodexTrace(startTime, workspacePath, linked);
    if (trace) {
      return { agent: "codex", confidence: linkedCount ? "high" : "medium", trace, linked_sessions: linkedCount };
    }
    return { agent: "codex", confidence: "low", trace: null, linked_sessions: linkedCount };
  }

  return { agent: "unknown", confidence: "low", trace: null };
}

export function agentLabel(choice: AgentChoice): string {
  switch (choice) {
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "codex":
      return "Codex";
  }
}
