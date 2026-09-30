import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentChoice } from "./detector.js";

/**
 * Agent sessions linked to a challenge workspace, in <workspace>/.kodwai/agent-sessions.json.
 *
 * Two writers keep this file:
 *  - the kodwai plugin for Claude Code, Codex and Cursor (github.com/kodwai/plugin),
 *    whose SessionStart/Stop hooks record each session's id and transcript path;
 *  - this CLI, when `kodwai challenge` / `kodwai submit` run inside an agent that
 *    exposes its session id to shell commands (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID).
 *
 * Collectors read it to pick up the exact transcript, which also covers sessions
 * started in the folder above the workspace. Only ids and paths are stored.
 */
export interface LinkedSession {
  agent: AgentChoice;
  session_id: string;
  transcript_path?: string | null;
  cwd?: string | null;
  first_seen?: string;
  last_seen?: string;
  last_event?: string | null;
}

interface LinkedSessionsFile {
  version: number;
  sessions: LinkedSession[];
}

const MAX_SESSIONS = 50;

function filePath(workspacePath: string): string {
  return join(workspacePath, ".kodwai", "agent-sessions.json");
}

/** Linked sessions for one agent. Missing or unreadable file means none. */
export async function readLinkedSessions(workspacePath: string, agent: AgentChoice): Promise<LinkedSession[]> {
  let data: Partial<LinkedSessionsFile>;
  try {
    data = JSON.parse(await readFile(filePath(workspacePath), "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(data?.sessions)) return [];
  return data.sessions.filter(
    (s): s is LinkedSession => !!s && s.agent === agent && typeof s.session_id === "string" && s.session_id.length > 0,
  );
}

/**
 * The session id of the agent running this command, from its environment.
 * Only the chosen agent's variable counts: an agent started from another
 * agent's terminal inherits the outer one's variables too.
 */
export function envSessionId(agent: AgentChoice, env: NodeJS.ProcessEnv = process.env): string | null {
  const id =
    agent === "claude-code" ? env.CLAUDE_CODE_SESSION_ID : agent === "codex" ? env.CODEX_THREAD_ID || env.CODEX_SESSION_ID : undefined;
  return id && /^[A-Za-z0-9-]{8,}$/.test(id) ? id : null;
}

/** Which agent is running this command, when it isn't a terminal. Codex first: it inherits Claude Code's variables when started from it. */
export function agentFromEnv(env: NodeJS.ProcessEnv = process.env): AgentChoice | null {
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return "codex";
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_SESSION_ID) return "claude-code";
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return "cursor";
  return null;
}

/** Record (or refresh) a session link. Same format and rules as the plugin's hook script. */
export async function linkSession(
  workspacePath: string,
  entry: Omit<LinkedSession, "first_seen" | "last_seen">,
  now = new Date().toISOString(),
): Promise<void> {
  const path = filePath(workspacePath);
  let sessions: LinkedSession[] = [];
  try {
    const data = JSON.parse(await readFile(path, "utf-8"));
    if (Array.isArray(data?.sessions)) sessions = data.sessions.filter((s: LinkedSession) => s && s.session_id);
  } catch {
    // first link
  }
  const existing = sessions.find((s) => s.agent === entry.agent && s.session_id === entry.session_id);
  if (existing) {
    if (entry.transcript_path) existing.transcript_path = entry.transcript_path;
    if (entry.cwd) existing.cwd = entry.cwd;
    existing.last_event = entry.last_event ?? existing.last_event ?? null;
    existing.last_seen = now;
  } else {
    sessions.push({ ...entry, first_seen: now, last_seen: now });
  }
  sessions.sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  const body: LinkedSessionsFile = { version: 1, sessions: sessions.slice(0, MAX_SESSIONS) };
  await mkdir(join(workspacePath, ".kodwai"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

/** Link the session of the agent running this command, if it exposes one. Never throws. */
export async function linkEnvSession(workspacePath: string, agent: AgentChoice, event: string): Promise<boolean> {
  const sessionId = envSessionId(agent);
  if (!sessionId) return false;
  try {
    await linkSession(workspacePath, { agent, session_id: sessionId, cwd: process.cwd(), last_event: event });
    return true;
  } catch {
    return false;
  }
}
