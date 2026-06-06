import { describe, it, expect } from "vitest";
import { parseCodexRollout, codexCwdMatches } from "../src/traces/codex.js";

const line = (obj: unknown) => JSON.stringify(obj);

describe("parseCodexRollout", () => {
  it("extracts cwd from session_meta", () => {
    const content = line({
      timestamp: "2026-06-06T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "s1", cwd: "/Users/x/proj", cli_version: "0.130.0" },
    });
    expect(parseCodexRollout(content).cwd).toBe("/Users/x/proj");
  });

  it("maps user and assistant messages to turns", () => {
    const content = [
      line({ timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a route" }] } }),
      line({ timestamp: "t2", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } }),
    ].join("\n");
    const { turns } = parseCodexRollout(content);
    expect(turns).toEqual([
      { role: "user", content: "add a route", timestamp: "t1" },
      { role: "assistant", content: "done", timestamp: "t2" },
    ]);
  });

  it("skips developer, system, and reasoning items", () => {
    const content = [
      line({ timestamp: "t1", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] } }),
      line({ timestamp: "t2", type: "response_item", payload: { type: "message", role: "system", content: [{ type: "input_text", text: "sys" }] } }),
      line({ timestamp: "t3", type: "response_item", payload: { type: "reasoning", content: [{ type: "text", text: "thinking" }] } }),
    ].join("\n");
    expect(parseCodexRollout(content).turns).toEqual([]);
  });

  it("pairs function_call with function_call_output by call_id", () => {
    const content = [
      line({ timestamp: "t1", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"cmd\":\"ls\"}", call_id: "c1" } }),
      line({ timestamp: "t2", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "file.txt" } }),
    ].join("\n");
    const { turns } = parseCodexRollout(content);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("assistant");
    expect(turns[0].tool_calls).toEqual([{ name: "shell", input: "{\"cmd\":\"ls\"}", output: "file.txt" }]);
  });

  it("reads token usage from event_msg token_count", () => {
    const content = line({
      timestamp: "t1", type: "event_msg",
      payload: { type: "token_count", info: { input_tokens: 120, output_tokens: 45 } },
    });
    expect(parseCodexRollout(content).tokenUsage).toEqual({ input: 120, output: 45 });
  });

  it("skips malformed lines without throwing", () => {
    const content = [
      "not json",
      line({ timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }),
    ].join("\n");
    expect(parseCodexRollout(content).turns).toHaveLength(1);
  });
});

describe("codexCwdMatches", () => {
  it("matches exact, parent, and child paths; rejects unrelated and null", () => {
    expect(codexCwdMatches("/a/b", "/a/b")).toBe(true);
    expect(codexCwdMatches("/a/b", "/a/b/c")).toBe(true);
    expect(codexCwdMatches("/a/b/c", "/a/b")).toBe(true);
    expect(codexCwdMatches("/a/x", "/a/b")).toBe(false);
    expect(codexCwdMatches(null, "/a/b")).toBe(false);
  });
});
