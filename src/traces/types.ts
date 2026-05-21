export interface TraceTurn {
  role: "user" | "assistant";
  content: string;
  tool_calls?: { name: string; input: string; output: string }[];
  timestamp?: string;
}

export interface AgentTrace {
  agent: string;
  turns: TraceTurn[];
  token_usage?: { input: number; output: number };
  trace_quality: "full" | "good" | "partial" | "minimal";
}

export interface AgentDetection {
  agent: "claude-code" | "cursor" | "unknown";
  confidence: "high" | "medium" | "low";
  trace: AgentTrace | null;
}
