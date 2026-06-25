import type { AgentTrace } from "./types.js";

export function createFallbackTrace(gitLog: any[]): AgentTrace {
  return {
    agent: "unknown",
    turns: [],
    trace_quality: "minimal",
  };
}
