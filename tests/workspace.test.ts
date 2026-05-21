import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "../src/session/workspace.js";
import type { SessionConfig } from "../src/session/config.js";

const mockConfig: SessionConfig = {
  session_id: "abc123def456",
  session_token: "token",
  webhook_secret: "secret",
  api_key: "sk-ant-test",
  project_title: "Rate Limiter Challenge",
  problem_statement_md: "# Problem\n\nBuild a rate limiter.",
  time_limit_minutes: 60,
  difficulty: "medium",
  allowed_tools: null,
  disallowed_tools: null,
  rubric: [],
  max_budget_usd: null,
  starter_files: null,
};

let createdPath: string | null = null;

afterEach(async () => {
  if (createdPath) {
    await rm(createdPath, { recursive: true, force: true });
    createdPath = null;
  }
});

describe("createWorkspace", () => {
  it("should create a directory with the project name", async () => {
    const path = await createWorkspace(mockConfig);
    createdPath = path;

    expect(path).toContain("kodwai-rate-limiter-challenge-abc123de");
  });

  it("should create a PROBLEM.md file", async () => {
    const path = await createWorkspace(mockConfig);
    createdPath = path;

    const content = await readFile(join(path, "PROBLEM.md"), "utf-8");
    expect(content).toContain("Rate Limiter Challenge");
    expect(content).toContain("Build a rate limiter.");
  });

  it("should sanitize special characters in directory name", async () => {
    const config = { ...mockConfig, project_title: "My Project! @#$% (v2)" };
    const path = await createWorkspace(config);
    createdPath = path;

    expect(path).not.toMatch(/[!@#$%()]/);
    expect(path).toContain("kodwai-my-project-v2-");
  });
});
