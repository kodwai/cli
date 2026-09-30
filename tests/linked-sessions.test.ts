import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, utimes, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInjectedUserText } from "../src/traces/injected.js";
import {
  agentFromEnv,
  envSessionId,
  linkSession,
  readLinkedSessions,
} from "../src/traces/linked-sessions.js";
import { collectClaudeCodeTrace, parseClaudeCodeTranscript } from "../src/traces/claude-code.js";
import { collectCodexTraceFrom, parseCodexRollout } from "../src/traces/codex.js";
import { parseCursorTranscript } from "../src/traces/cursor.js";

const line = (obj: unknown) => JSON.stringify(obj);
const START = new Date("2026-09-30T10:00:00.000Z");

describe("isInjectedUserText", () => {
  it("flags harness-injected context", () => {
    for (const text of [
      "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>",
      "# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>...",
      "<skill>\n<name>kodwai:submit</name>",
      "<task-notification> <task-id>a1</task-id>",
      "<local-command-stdout>Set model</local-command-stdout>",
      "<turn_aborted> The user interrupted",
      "  <system-reminder>note</system-reminder>",
    ]) {
      expect(isInjectedUserText(text), text).toBe(true);
    }
  });

  it("flags kodwai's own commands", () => {
    expect(isInjectedUserText("/kodwai:submit")).toBe(true);
    expect(isInjectedUserText("$kodwai:status")).toBe(true);
    expect(isInjectedUserText("<command-name>/kodwai:challenge</command-name> <command-args>rate-limiter</command-args>")).toBe(true);
    expect(isInjectedUserText("<command-message>kodwai:submit</command-message>")).toBe(true);
  });

  it("keeps what the user actually wrote, including other slash commands", () => {
    for (const text of [
      "add a token bucket, but keep the API the same",
      "why does <skill> appear in the output?",
      "<command-name>/review</command-name> <command-args>focus on the retry logic</command-args>",
      "is kodwai:submit safe to run twice?",
    ]) {
      expect(isInjectedUserText(text), text).toBe(false);
    }
  });
});

describe("envSessionId / agentFromEnv", () => {
  it("reads only the chosen agent's variable", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "11111111-aaaa", CODEX_THREAD_ID: "22222222-bbbb" };
    expect(envSessionId("claude-code", env)).toBe("11111111-aaaa");
    expect(envSessionId("codex", env)).toBe("22222222-bbbb");
    expect(envSessionId("cursor", env)).toBeNull();
    expect(envSessionId("codex", { CODEX_SESSION_ID: "33333333-cccc" })).toBe("33333333-cccc");
    expect(envSessionId("claude-code", { CLAUDE_CODE_SESSION_ID: "../../etc" })).toBeNull();
  });

  it("prefers Codex: it inherits Claude Code's variables when started from it", () => {
    expect(agentFromEnv({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CODEX_THREAD_ID: "y" })).toBe("codex");
    expect(agentFromEnv({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(agentFromEnv({ CURSOR_AGENT: "1" })).toBe("cursor");
    expect(agentFromEnv({})).toBeNull();
  });
});

describe("linkSession / readLinkedSessions", () => {
  it("upserts per agent and session, and reads back one agent's links", async () => {
    const ws = await mkdtemp(join(tmpdir(), "kodwai-link-"));
    await linkSession(ws, { agent: "claude-code", session_id: "s1", transcript_path: "/t/s1.jsonl", last_event: "SessionStart" }, "2026-09-30T10:00:00Z");
    await linkSession(ws, { agent: "claude-code", session_id: "s1", last_event: "submit" }, "2026-09-30T10:30:00Z");
    await linkSession(ws, { agent: "codex", session_id: "s2", last_event: "challenge" }, "2026-09-30T10:31:00Z");

    const cc = await readLinkedSessions(ws, "claude-code");
    expect(cc).toHaveLength(1);
    expect(cc[0]).toMatchObject({ session_id: "s1", transcript_path: "/t/s1.jsonl", first_seen: "2026-09-30T10:00:00Z", last_seen: "2026-09-30T10:30:00Z", last_event: "submit" });
    expect(await readLinkedSessions(ws, "codex")).toHaveLength(1);
    expect(await readLinkedSessions(ws, "cursor")).toEqual([]);
  });

  it("reads the plugin's file format and ignores a broken file", async () => {
    const ws = await mkdtemp(join(tmpdir(), "kodwai-link-"));
    await mkdir(join(ws, ".kodwai"));
    // Exactly what plugins/kodwai/scripts/record-session.mjs writes.
    await writeFile(
      join(ws, ".kodwai", "agent-sessions.json"),
      JSON.stringify({ version: 1, sessions: [{ agent: "cursor", session_id: "c1", transcript_path: "/t/c1.jsonl", cwd: ws, last_event: "stop", agent_version: "2.6.1", first_seen: "a", last_seen: "b" }] }),
    );
    expect((await readLinkedSessions(ws, "cursor"))[0].transcript_path).toBe("/t/c1.jsonl");
    await writeFile(join(ws, ".kodwai", "agent-sessions.json"), "{nope");
    expect(await readLinkedSessions(ws, "cursor")).toEqual([]);
  });
});

describe("parseClaudeCodeTranscript", () => {
  it("drops isMeta lines, injected text and kodwai commands, keeps the user's words", () => {
    const content = [
      line({ type: "user", timestamp: "2026-09-30T10:01:00Z", message: { content: "<command-name>/kodwai:challenge</command-name>" } }),
      line({ type: "user", isMeta: true, timestamp: "2026-09-30T10:01:01Z", message: { content: [{ type: "text", text: "Base directory for this skill: /p/skills/challenge\n# Start a kodwai challenge" }] } }),
      line({ type: "user", timestamp: "2026-09-30T10:02:00Z", message: { content: "use a sliding window, not a fixed one" } }),
      line({ type: "assistant", timestamp: "2026-09-30T10:02:05Z", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "On it." }, { type: "tool_use", name: "Edit", input: { file: "a.ts" } }] } }),
      line({ type: "user", timestamp: "2026-09-30T09:00:00Z", message: { content: "before the challenge" } }),
    ].join("\n");
    const { turns, models } = parseClaudeCodeTranscript(content, START);
    expect(turns.map((t) => [t.role, t.content])).toEqual([
      ["user", "use a sliding window, not a fixed one"],
      ["assistant", "On it."],
    ]);
    expect(turns[1].tool_calls?.[0].name).toBe("Edit");
    expect(models).toEqual(["claude-opus-5-5"]);
  });
});

describe("collectClaudeCodeTrace with linked sessions", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "kodwai-cc-"));
    const projects = join(root, "projects");
    const parent = join(root, "work");
    const ws = join(parent, "kodwai-rate-limiter");
    // The session was started in the parent folder, so Claude Code filed it under the parent's name.
    const parentDir = join(projects, parent.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(parentDir, { recursive: true });
    await mkdir(ws, { recursive: true });
    const transcript = join(parentDir, "sess-1.jsonl");
    await writeFile(
      transcript,
      [
        line({ type: "user", timestamp: "2026-09-30T10:05:00Z", message: { content: "write the failing test first" } }),
        line({ type: "assistant", timestamp: "2026-09-30T10:05:10Z", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } }),
      ].join("\n"),
    );
    return { projects, ws, transcript };
  }

  it("finds nothing by folder name when the session ran in the parent folder", async () => {
    const { projects, ws } = await setup();
    expect(await collectClaudeCodeTrace(START, ws, [], projects)).toBeNull();
  });

  it("reads the linked transcript path", async () => {
    const { projects, ws, transcript } = await setup();
    const trace = await collectClaudeCodeTrace(START, ws, [{ agent: "claude-code", session_id: "sess-1", transcript_path: transcript }], projects);
    expect(trace?.turns.map((t) => t.content)).toEqual(["write the failing test first", "Done."]);
    expect(trace?.model_raw).toBe("claude-opus-5-5");
  });

  it("finds a linked session by id when only the id is known (CLAUDE_CODE_SESSION_ID)", async () => {
    const { projects, ws } = await setup();
    const trace = await collectClaudeCodeTrace(START, ws, [{ agent: "claude-code", session_id: "sess-1" }], projects);
    expect(trace?.turns).toHaveLength(2);
  });

  it("doesn't read a transcript twice when it's both linked and in the workspace folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodwai-cc-"));
    const projects = join(root, "projects");
    const ws = join(root, "kodwai-queue");
    const dir = join(projects, ws.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(dir, { recursive: true });
    const transcript = join(dir, "s.jsonl");
    await writeFile(transcript, line({ type: "user", timestamp: "2026-09-30T10:05:00Z", message: { content: "hello" } }));
    const future = new Date("2026-09-30T11:00:00Z");
    await utimes(transcript, future, future);
    const trace = await collectClaudeCodeTrace(START, ws, [{ agent: "claude-code", session_id: "s", transcript_path: transcript }], projects);
    expect(trace?.turns).toHaveLength(1);
  });
});

describe("the same transcript reached through a symlink", () => {
  it("is read once (Claude Code)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodwai-cc-"));
    const projects = join(root, "projects");
    const ws = join(root, "kodwai-queue");
    const dir = join(projects, ws.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s.jsonl"), line({ type: "user", timestamp: "2026-09-30T10:05:00Z", message: { content: "hello" } }));
    const future = new Date("2026-09-30T11:00:00Z");
    await utimes(join(dir, "s.jsonl"), future, future);
    await symlink(projects, join(root, "projects-link"));
    const viaLink = join(root, "projects-link", ws.replace(/[^a-zA-Z0-9]/g, "-"), "s.jsonl");
    const trace = await collectClaudeCodeTrace(START, ws, [{ agent: "claude-code", session_id: "s", transcript_path: viaLink }], projects);
    expect(trace?.turns).toHaveLength(1);
  });

  it("is read once (Codex)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodwai-codex-"));
    const day = join(root, "sessions", "2026", "09", "30");
    await mkdir(day, { recursive: true });
    const ws = join(root, "kodwai-demo");
    const name = "rollout-2026-09-30T10-00-00-abcdef12-3456.jsonl";
    await writeFile(
      join(day, name),
      [
        line({ timestamp: "2026-09-30T10:00:00Z", type: "session_meta", payload: { cwd: ws, originator: "codex_exec", thread_source: "user" } }),
        line({ timestamp: "2026-09-30T10:01:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] } }),
      ].join("\n"),
    );
    await symlink(join(root, "sessions"), join(root, "sessions-link"));
    const viaLink = join(root, "sessions-link", "2026", "09", "30", name);
    const trace = await collectCodexTraceFrom(join(root, "sessions"), START, ws, [{ agent: "codex", session_id: "abcdef12-3456", transcript_path: viaLink }]);
    expect(trace?.turns).toHaveLength(1);
  });
});

describe("Codex: injected context and linked rollouts", () => {
  it("skips environment context, AGENTS.md and skill bodies logged as user messages", () => {
    const msg = (role: string, text: string) =>
      line({ timestamp: "2026-09-30T10:01:00Z", type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
    const { turns } = parseCodexRollout(
      [
        msg("user", "<environment_context>\n  <cwd>/w</cwd>\n</environment_context>"),
        msg("user", "# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>"),
        msg("user", "<skill>\n<name>kodwai:submit</name>"),
        msg("user", "$kodwai:submit"),
        msg("user", "handle the empty-bucket case"),
      ].join("\n"),
    );
    expect(turns.map((t) => t.content)).toEqual(["handle the empty-bucket case"]);
  });

  it("takes a linked rollout even when its cwd is elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodwai-codex-"));
    const sessions = join(root, "sessions", "2026", "09", "30");
    await mkdir(sessions, { recursive: true });
    const id = "01a0f1e7-0259-7b80-bff7-e5d5c21d39cc";
    const rollout = join(sessions, `rollout-2026-09-30T10-00-00-${id}.jsonl`);
    await writeFile(
      rollout,
      [
        line({ timestamp: "2026-09-30T10:00:00Z", type: "session_meta", payload: { id, cwd: "/somewhere/else", originator: "codex_exec", thread_source: "user" } }),
        line({ timestamp: "2026-09-30T10:01:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "start with the parser" }] } }),
      ].join("\n"),
    );
    const ws = join(root, "work", "kodwai-demo");
    expect(await collectCodexTraceFrom(join(root, "sessions"), START, ws)).toBeNull();
    const byPath = await collectCodexTraceFrom(join(root, "sessions"), START, ws, [{ agent: "codex", session_id: id, transcript_path: rollout }]);
    expect(byPath?.turns.map((t) => t.content)).toEqual(["start with the parser"]);
    const byId = await collectCodexTraceFrom(join(root, "sessions"), START, ws, [{ agent: "codex", session_id: id }]);
    expect(byId?.turns).toHaveLength(1);
  });
});

describe("parseCursorTranscript", () => {
  it("reads Anthropic-style lines, drops injected text and pre-start lines", () => {
    const content = [
      line({ role: "user", message: { content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }] } }),
      line({ role: "user", message: { content: [{ type: "text", text: "keep it dependency-free" }] } }),
      line({ role: "assistant", message: { content: [{ type: "text", text: "Okay." }, { type: "tool_use", name: "edit_file", input: { path: "a.ts" } }] } }),
      line({ role: "user", timestamp: "2026-09-30T09:00:00Z", message: { content: "old" } }),
      "not json",
    ].join("\n");
    const { turns } = parseCursorTranscript(content, START);
    expect(turns.map((t) => [t.role, t.content])).toEqual([
      ["user", "keep it dependency-free"],
      ["assistant", "Okay."],
    ]);
    expect(turns[1].tool_calls?.[0].name).toBe("edit_file");
  });
});

describe("plugin compatibility", () => {
  it("writes the same shape as the plugin's hook script", async () => {
    // Two writers share .kodwai/agent-sessions.json: keep the shape in sync.
    const ws = await mkdtemp(join(tmpdir(), "kodwai-link-"));
    await linkSession(ws, { agent: "codex", session_id: "x1", last_event: "challenge" });
    const raw = JSON.parse(await readFile(join(ws, ".kodwai", "agent-sessions.json"), "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.sessions[0]).toMatchObject({ agent: "codex", session_id: "x1", last_event: "challenge" });
    expect(Object.keys(raw.sessions[0])).toEqual(expect.arrayContaining(["agent", "session_id", "first_seen", "last_seen"]));
  });
});
