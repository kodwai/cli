import { collectClaudeCodeTrace } from "./claude-code.js";
import { collectCursorTrace } from "./cursor.js";
import { createFallbackTrace } from "./fallback.js";
import type { AgentDetection } from "./types.js";

export type AgentChoice = "claude-code" | "cursor";

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

  return { agent: "unknown", confidence: "low", trace: null };
}
