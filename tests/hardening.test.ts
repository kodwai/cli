import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRequest, errorDetail, ApiError, resolveApiUrl } from "../src/utils/api.js";
import { matchChoice } from "../src/utils/prompt.js";
import { collectWorkspaceFiles, isSecretFile, skipReason, summarizeFiles, countSourceFiles } from "../src/utils/collect.js";
import { collectGitData, initWorkspaceRepo } from "../src/utils/git.js";
import { parseTestCounts } from "../src/commands/submit.js";
import { parseAgent, safeJoin } from "../src/commands/challenge.js";
import { elapsed, findSubmissionMeta, writeSubmissionMeta } from "../src/utils/challenge-meta.js";

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodwai-test-")));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("api helpers", () => {
  it("reads FastAPI string and validation-list details", () => {
    expect(errorDetail({ detail: "Challenge not found" }, "x")).toBe("Challenge not found");
    expect(errorDetail({ detail: [{ loc: ["body", "time_taken_ms"], msg: "Input should be a valid integer" }] }, "x"))
      .toBe("time_taken_ms: Input should be a valid integer");
    expect(errorDetail(null, "fallback")).toBe("fallback");
  });

  it("normalizes the API URL", () => {
    expect(resolveApiUrl("http://localhost:8000/")).toBe("http://localhost:8000");
    vi.stubEnv("KODWAI_API_URL", "https://staging.example.com");
    expect(resolveApiUrl()).toBe("https://staging.example.com");
  });

  it("retries 5xx then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiRequest("http://x", "/y", { retries: 1 })).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400 and surfaces its detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Submission already submitted" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await apiRequest("http://x", "/y", { retries: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Submission already submitted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns a network failure into a readable message", async () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(e));
    const err = await apiRequest("http://localhost:8000", "/y", { retries: 0 }).catch((x) => x);
    expect(err.status).toBe(0);
    expect(err.message).toContain("connection refused");
  });
});

describe("prompts", () => {
  const agents = [
    { label: "Claude Code", aliases: ["claude", "cc"] },
    { label: "Cursor" },
    { label: "Codex" },
  ];
  it("accepts numbers, names and unique prefixes, rejects the rest", () => {
    expect(matchChoice("2", agents)).toBe(1);
    expect(matchChoice("claude", agents)).toBe(0);
    expect(matchChoice("Codex", agents)).toBe(2);
    expect(matchChoice("cur", agents)).toBe(1);
    expect(matchChoice("c", agents)).toBeNull(); // ambiguous
    expect(matchChoice("7", agents)).toBeNull();
    expect(matchChoice("", agents)).toBeNull();
  });
  it("parses --agent values", () => {
    expect(parseAgent("claude")).toBe("claude-code");
    expect(parseAgent("Claude-Code")).toBe("claude-code");
    expect(parseAgent("codex")).toBe("codex");
    expect(parseAgent("vim")).toBeNull();
  });
});

describe("safeJoin", () => {
  it("keeps starter files inside the workspace", () => {
    expect(safeJoin("/w", "src/app.ts")).toBe("/w/src/app.ts");
    expect(safeJoin("/w", "../evil.sh")).toBeNull();
    expect(safeJoin("/w", "a/../../evil")).toBeNull();
    expect(safeJoin("/w", "/etc/passwd")).toBeNull();
    expect(safeJoin("/w", "")).toBeNull();
  });
});

describe("file collection", () => {
  it("flags secret files but keeps templates", () => {
    expect(isSecretFile(".env")).toBe(true);
    expect(isSecretFile(".env.local")).toBe(true);
    expect(isSecretFile(".env.example")).toBe(false);
    expect(isSecretFile("server.pem")).toBe(true);
    expect(isSecretFile("id_ed25519")).toBe(true);
    expect(isSecretFile("env.ts")).toBe(false);
    expect(skipReason("node_modules/x/index.js")).toBe("dir");
    expect(skipReason("bun.lock")).toBe("file");
    expect(skipReason("src/app.ts")).toBeNull();
  });

  it("collects source, skips secrets/deps/binaries, respects .gitignore", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules/lib"), { recursive: true });
    await mkdir(join(dir, "out"), { recursive: true });
    await writeFile(join(dir, "src/app.ts"), "export const a = 1;\n");
    await writeFile(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-secret\n");
    await writeFile(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\n");
    await writeFile(join(dir, "node_modules/lib/index.js"), "x");
    await writeFile(join(dir, "blob.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(dir, "out/gen.js"), "generated");
    await writeFile(join(dir, ".gitignore"), "out/\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });

    const res = await collectWorkspaceFiles(dir);
    const paths = res.files.map((f) => f.path).sort();
    expect(paths).toEqual([".env.example", ".gitignore", "src/app.ts"]);
    expect(res.secrets).toEqual([".env"]);
    expect(JSON.stringify(res.files)).not.toContain("sk-secret");
    expect(summarizeFiles(res.files)).toBe("src/ (1), 2 top-level files");
    expect(countSourceFiles(res.files)).toBe(1);
  });

  it("falls back to a directory walk outside git", async () => {
    await mkdir(join(dir, "pkg"), { recursive: true });
    await writeFile(join(dir, "pkg/main.go"), "package main\n");
    await writeFile(join(dir, "main_test.go"), "package main\n");
    const res = await collectWorkspaceFiles(dir);
    expect(res.files.map((f) => f.path).sort()).toEqual(["main_test.go", "pkg/main.go"]);
  });
});

describe("git", () => {
  it("makes the starter commit with no git identity and gpg signing forced on", async () => {
    // A machine with no user.name/email and commit.gpgsign=true in its global config.
    const home = join(dir, "home");
    await mkdir(home);
    await writeFile(join(home, ".gitconfig"), "[commit]\n\tgpgsign = true\n");
    vi.stubEnv("HOME", home);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, ".gitconfig"));
    vi.stubEnv("GIT_AUTHOR_NAME", "");
    vi.stubEnv("GIT_AUTHOR_EMAIL", "");
    vi.stubEnv("GIT_COMMITTER_NAME", "");
    vi.stubEnv("GIT_COMMITTER_EMAIL", "");
    vi.stubEnv("EMAIL", "");
    const ws = join(dir, "ws");
    await mkdir(ws);
    await writeFile(join(ws, "PROBLEM.md"), "# p\n");

    expect(() => initWorkspaceRepo(ws)).not.toThrow();
    const log = execFileSync("git", ["log", "--format=%an|%s"], { cwd: ws, encoding: "utf-8" }).trim();
    expect(log).toBe("kodwai|Initial: challenge starter files");
  });

  it("diffs everything since the starter commit (incl. untracked) without touching the index", async () => {
    const ws = join(dir, "ws");
    await mkdir(ws);
    await writeFile(join(ws, "PROBLEM.md"), "# p\n");
    initWorkspaceRepo(ws);
    // One commit with a message full of quotes/braces, then uncommitted + untracked work.
    await writeFile(join(ws, "a.py"), "print('a')\n");
    execFileSync("git", ["add", "a.py"], { cwd: ws });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `feat: "quoted" {json} 'x'`], { cwd: ws });
    await writeFile(join(ws, "a.py"), "print('changed')\n");
    await writeFile(join(ws, "new_file.py"), "print('new')\n");
    const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: ws, encoding: "utf-8" });

    const data = collectGitData(ws, join(dir, "tmp-index"));
    expect(data.diff).toContain("new_file.py");
    expect(data.diff).toContain("print('changed')");
    expect(data.log.map((c) => c.message)).toEqual([`feat: "quoted" {json} 'x'`, "Initial: challenge starter files"]);
    expect(data.log[0].hash).toMatch(/^[0-9a-f]{40}$/);
    // The developer's staging area is exactly as it was.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: ws, encoding: "utf-8" })).toBe(statusBefore);
  });

  it("returns empty data outside a repo", () => {
    expect(collectGitData(dir, join(dir, "idx"))).toEqual({ diff: null, log: [] });
  });
});

describe("parseTestCounts", () => {
  it("reads the common runner summaries", () => {
    expect(parseTestCounts("5 passed, 1 failed out of 6")).toEqual({ passed: 5, failed: 1, total: 6 });
    expect(parseTestCounts("===== 5 passed, 1 failed in 0.21s =====")).toEqual({ passed: 5, failed: 1, total: 6 });
    expect(parseTestCounts("Tests:       1 failed, 12 passed, 13 total")).toEqual({ passed: 12, failed: 1, total: 13 });
    expect(parseTestCounts(" Tests  12 passed (12)")).toEqual({ passed: 12, failed: 0, total: 12 });
    expect(parseTestCounts(" 24 pass\n 0 fail\n 51 expect() calls")).toEqual({ passed: 24, failed: 0, total: 24 });
    expect(parseTestCounts("  3 passing (12ms)\n  1 failing")).toEqual({ passed: 3, failed: 1, total: 4 });
    expect(parseTestCounts("--- PASS: TestA\n--- FAIL: TestB\n")).toEqual({ passed: 1, failed: 1, total: 2 });
    expect(parseTestCounts("\x1b[32m7 passed\x1b[0m in 1s")).toEqual({ passed: 7, failed: 0, total: 7 });
    expect(parseTestCounts("nothing here")).toEqual({ passed: 0, failed: 0, total: 0 });
  });
});

describe("challenge metadata", () => {
  it("is found from a nested folder, and reports the folder it's in now", async () => {
    const ws = join(dir, "kodwai-x");
    await mkdir(join(ws, ".kodwai"), { recursive: true });
    await mkdir(join(ws, "src/deep/er/still/deeper/six"), { recursive: true });
    const meta = {
      submission_id: "s1", challenge_id: "c", challenge_slug: "x", agent_choice: "codex" as const,
      started_at: new Date().toISOString(), workspace_path: "/old/moved/path", api_url: "http://a", time_limit_minutes: 30,
    };
    await writeSubmissionMeta(join(ws, ".kodwai/submission.json"), meta);
    const found = await findSubmissionMeta(join(ws, "src/deep/er/still/deeper/six"));
    expect(found?.meta.submission_id).toBe("s1");
    expect(found?.workspacePath).toBe(ws);
    expect(JSON.parse(await readFile(join(ws, ".kodwai/submission.json"), "utf-8")).challenge_slug).toBe("x");
    expect(await findSubmissionMeta(dir)).toBeNull();
  });

  it("computes elapsed time and lateness", () => {
    const start = Date.parse("2026-09-28T10:00:00Z");
    expect(elapsed({ started_at: "2026-09-28T10:00:00Z", time_limit_minutes: 30 }, start + 20 * 60_000))
      .toMatchObject({ minutes: 20, late: false });
    expect(elapsed({ started_at: "2026-09-28T10:00:00Z", time_limit_minutes: 30 }, start + 31 * 60_000).late).toBe(true);
    expect(elapsed({ started_at: "garbage", time_limit_minutes: 30 }).ms).toBe(0);
  });
});
