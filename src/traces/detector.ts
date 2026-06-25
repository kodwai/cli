import { collectClaudeCodeTrace } from "./claude-code.js";
import { collectCursorTrace } from "./cursor.js";
import { collectCodexTrace } from "./codex.js";
import { createFallbackTrace } from "./fallback.js";
import type { AgentDetection } from "./types.js";

export type AgentChoice = "claude-code" | "cursor" | "codex";

export async function detectAndCollectTrace(
  agentChoice: AgentChoice,
  startTime: Date,
  workspacePath: string,
): Promise<AgentDetection> {
  if (agentChoice === "claude-code") {
    const trace = await collectClaudeCodeTrace(startTime, workspacePath);
    if (trace) {
      return { agent: "claude-code", confidence: "high", trace };
    }
    return { agent: "claude-code", confidence: "low", trace: null };
  }

  if (agentChoice === "cursor") {
    const trace = await collectCursorTrace(startTime, workspacePath);
    if (trace) {
      return { agent: "cursor", confidence: "medium", trace };
    }
    return { agent: "cursor", confidence: "low", trace: null };
  }

  if (agentChoice === "codex") {
    const trace = await collectCodexTrace(startTime, workspacePath);
    if (trace) {
      return { agent: "codex", confidence: "medium", trace };
    }
    return { agent: "codex", confidence: "low", trace: null };
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
