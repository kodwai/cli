export interface SessionConfig {
  session_id: string;
  session_token: string;
  webhook_secret: string;
  api_key: string;          // session token (NOT the real key)
  proxy_base_url: string;   // ANTHROPIC_BASE_URL — routes through Kodwai proxy
  project_title: string;
  problem_statement_md: string;
  time_limit_minutes: number;
  difficulty: string | null;
  allowed_tools: string[] | null;
  disallowed_tools: string[] | null;
  rubric: { name: string; weight: number; description: string }[];
  max_budget_usd: number | null;
  starter_files: string | null;
}

export async function fetchSessionConfig(
  sessionId: string,
  baseUrl: string,
  sessionToken?: string,
): Promise<SessionConfig> {
  const token = sessionToken || sessionId;
  const url = `${baseUrl}/api/sessions/${sessionId}/config?session_token=${token}`;

  const resp = await fetch(url);

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ detail: "Unknown error" }));

    if (resp.status === 404) {
      throw new Error("Session not found. Check your session ID and try again.");
    }
    if (resp.status === 400) {
      throw new Error(body.detail || "Session cannot be started.");
    }
    throw new Error(body.detail || `Failed to fetch session config (${resp.status})`);
  }

  return resp.json();
}
