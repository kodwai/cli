import { describe, it, expect } from "vitest";
import { agentLabel } from "../src/traces/detector.js";

describe("agentLabel", () => {
  it("maps each agent choice to a display label", () => {
    expect(agentLabel("claude-code")).toBe("Claude Code");
    expect(agentLabel("cursor")).toBe("Cursor");
    expect(agentLabel("codex")).toBe("Codex");
  });
});
