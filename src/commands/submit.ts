import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { display } from "../utils/display.js";
import { getStoredToken } from "../utils/auth.js";
import { detectAndCollectTrace, type AgentChoice } from "../traces/detector.js";

// Directories and files to skip when collecting code snapshot
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".nuxt", "dist", "build", ".turbo", ".cache",
  "__pycache__", ".venv", "venv", "vendor", "target", ".gradle",
  ".git", ".claude", ".kodwai", ".idea", ".vscode", "coverage",
]);
const SKIP_EXTENSIONS = new Set([
  ".pyc", ".class", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".mp4", ".zip", ".tar", ".gz", ".pdf", ".db", ".sqlite", ".map",
  ".woff", ".woff2", ".ttf", ".eot",
]);
const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Pipfile.lock",
  "poetry.lock", ".DS_Store", "Thumbs.db",
]);
const MAX_FILE_SIZE = 500_000; // 500KB

interface SubmissionMeta {
  submission_id: string;
  challenge_id: string;
  challenge_slug: string;
  agent_choice: AgentChoice;
  started_at: string;
  workspace_path: string;
  api_url: string;
  time_limit_minutes: number;
  test_suite?: any[];
}

export async function submitChallenge(): Promise<void> {
  display.banner();

  // 1. Find .kodwai/submission.json
  const meta = await findSubmissionMeta(process.cwd());
  if (!meta) {
    throw new Error("No active challenge found. Run 'kodwai challenge <id>' first, then cd into the workspace.");
  }

  const startTime = new Date(meta.started_at);
  const elapsedMs = Date.now() - startTime.getTime();
  const elapsedMin = Math.round(elapsedMs / 60000);
  const timeLimitMs = meta.time_limit_minutes * 60000;

  const isLate = elapsedMs > timeLimitMs;
  if (isLate) {
    const overBy = elapsedMin - meta.time_limit_minutes;
    display.warning(`Time limit exceeded by ${overBy} min (${elapsedMin}/${meta.time_limit_minutes} min)`);
    display.warning("You can still submit, but a late penalty will be applied to your score.");
  } else {
    display.info(`Time: ${elapsedMin}/${meta.time_limit_minutes} min`);
  }

  // 2. Collect code snapshot
  display.info("Collecting files...");
  const codeSnapshot = await collectFiles(meta.workspace_path);
  display.success(`${codeSnapshot.length} files collected`);

  // 3. Collect git data
  //
  // Note: POSIX shell redirections (2>/dev/null) and || are not available on
  // Windows (cmd.exe). We use try/catch in JS instead so this works cross-platform.
  let gitDiff: string | null = null;
  let gitLog: any[] = [];
  try {
    try {
      gitDiff = execSync("git diff HEAD~100..HEAD", {
        cwd: meta.workspace_path,
        encoding: "utf-8",
        maxBuffer: 5_000_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).slice(0, 500_000);
    } catch {
      try {
        gitDiff = execSync("git diff", {
          cwd: meta.workspace_path,
          encoding: "utf-8",
          maxBuffer: 5_000_000,
          stdio: ["pipe", "pipe", "pipe"],
        }).slice(0, 500_000);
      } catch {
        gitDiff = null;
      }
    }

    const logOutput = execSync(
      'git log --format=\'{"hash":"%H","message":"%s","timestamp":"%aI"}\'',
      {
        cwd: meta.workspace_path,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    gitLog = logOutput.trim().split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    display.success(`${gitLog.length} git commits collected`);
  } catch {
    display.info("No git history available");
  }

  // 4. Run tests locally if test suite defined
  let testResults: { passed: number; failed: number; total: number; output: string } | null = null;
  if (meta.test_suite && meta.test_suite.length > 0) {
    display.info("Running tests...");
    testResults = await runLocalTests(meta.workspace_path, meta.test_suite);
    if (testResults) {
      const status = testResults.failed === 0 ? "✓" : "⚠";
      display.info(`${status} Tests: ${testResults.passed}/${testResults.total} passed`);
    }
  }

  // 5. Collect agent traces
  display.info(`Collecting ${meta.agent_choice} traces...`);
  const detection = await detectAndCollectTrace(meta.agent_choice, startTime, meta.workspace_path);
  if (detection.trace) {
    display.success(`Agent: ${detection.agent} (${detection.trace.trace_quality} quality, ${detection.trace.turns.length} turns)`);
  } else {
    display.info(`No ${meta.agent_choice} traces found — submitting with code only`);
  }

  // 6. Summary + confirm
  const traceturns = detection.trace?.turns.length || 0;
  const payloadSizeKb = Math.round(JSON.stringify({
    code_snapshot: codeSnapshot.map((f) => ({ path: f.path, content: f.content })),
    git_diff: gitDiff, git_log: gitLog, test_results: testResults,
    agent_used: detection.agent, agent_trace: detection.trace, time_taken_ms: elapsedMs,
  }).length / 1024);

  display.divider();
  console.log("");
  console.log("  SUBMISSION SUMMARY");
  console.log("");
  console.log(`  Challenge:     ${meta.challenge_slug}`);
  console.log(`  Workspace:     ${meta.workspace_path}`);
  console.log(`  Files:         ${codeSnapshot.length} files (from challenge directory only)`);
  console.log(`  Commits:       ${gitLog.length}`);
  console.log(`  Tests:         ${testResults ? `${testResults.passed}/${testResults.total} passed` : "none"}`);
  console.log(`  Agent traces:  ${traceturns} turns from ${detection.agent} (this session only)`);
  console.log(`  Time:          ${elapsedMin}/${meta.time_limit_minutes} min${isLate ? " (LATE — penalty will apply)" : ""}`);
  console.log(`  Payload size:  ~${payloadSizeKb} KB`);
  console.log("");
  console.log("  No files outside the challenge directory were accessed.");
  console.log("  Only AI traces from this challenge session are included.");
  console.log("");

  const answer = await confirmWithOptions("  Submit (y), view payload (v), or cancel (n)? ");
  if (answer === "v") {
    // Show full payload details
    console.log("\n  --- FILES ---");
    for (const f of codeSnapshot) {
      console.log(`    ${f.path} (${f.content.length} chars)`);
    }
    if (detection.trace && detection.trace.turns.length > 0) {
      console.log("\n  --- AGENT TRACE (first 5 turns) ---");
      for (const turn of detection.trace.turns.slice(0, 5)) {
        const preview = turn.content.slice(0, 120).replace(/\n/g, " ");
        console.log(`    [${turn.role}] ${preview}${turn.content.length > 120 ? "..." : ""}`);
      }
      if (detection.trace.turns.length > 5) {
        console.log(`    ... and ${detection.trace.turns.length - 5} more turns`);
      }
    }
    console.log("");
    const confirmed2 = await confirm("  Submit now? (y/n): ");
    if (!confirmed2) {
      display.info("Submission cancelled.");
      return;
    }
  } else if (answer !== "y") {
    display.info("Submission cancelled.");
    return;
  }

  // 7. Submit to API
  display.info("Uploading submission...");
  // Re-authenticate if needed (token may have expired)
  const { ensureAuth } = await import("../utils/auth.js");
  const token = await ensureAuth(meta.api_url);

  const body = {
    code_snapshot: codeSnapshot.map((f) => ({ path: f.path, content: f.content })),
    git_diff: gitDiff,
    git_log: gitLog,
    test_results: testResults,
    agent_used: detection.agent,
    agent_trace: detection.trace,
    time_taken_ms: elapsedMs,
  };

  const resp = await fetch(`${meta.api_url}/api/submissions/${meta.submission_id}/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: "Submission failed" }));
    throw new Error(err.detail || "Submission failed");
  }

  display.success("Submission received! Scoring in progress...");
  display.info("");
  // Derive client URL from API URL
  let clientUrl = meta.api_url.replace("api.", "app.");
  if (clientUrl.includes("localhost:8000")) {
    clientUrl = clientUrl.replace("localhost:8000", "localhost:3000");
  }
  display.info(`  View results: ${clientUrl}/dev/submissions/${meta.submission_id}`);
  display.info("");

  // Check if user has API key
  try {
    const keysResp = await fetch(`${meta.api_url}/api/api-keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (keysResp.ok) {
      const keys = await keysResp.json();
      if (keys.length === 0) {
        display.warning("Add your Anthropic API key at kodwai.com/dev/settings for full AI-powered scoring.");
      }
    }
  } catch {
    // Ignore
  }
}

async function findSubmissionMeta(startDir: string): Promise<SubmissionMeta | null> {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    try {
      const metaPath = join(dir, ".kodwai", "submission.json");
      const content = await readFile(metaPath, "utf-8");
      return JSON.parse(content);
    } catch {
      dir = join(dir, "..");
    }
  }
  return null;
}

async function collectFiles(workspacePath: string): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) continue;
        const ext = "." + entry.name.split(".").pop()?.toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;

        try {
          const s = await stat(fullPath);
          if (s.size > MAX_FILE_SIZE) continue;
          const content = await readFile(fullPath, "utf-8");
          const relPath = relative(workspacePath, fullPath).replace(/\\/g, "/");
          files.push({ path: relPath, content });
        } catch {
          // Skip binary / unreadable files
        }
      }
    }
  }

  await walk(workspacePath);
  return files;
}

async function runLocalTests(
  workspacePath: string,
  testSuite: any[],
): Promise<{ passed: number; failed: number; total: number; output: string } | null> {
  // Use a random high port to avoid conflicts with running services
  const testPort = 10000 + Math.floor(Math.random() * 50000);
  const testEnv = { ...process.env, PORT: String(testPort), TEST_PORT: String(testPort) };

  for (const test of testSuite) {
    if (!test.command) continue;
    try {
      const output = execSync(test.command, {
        cwd: workspacePath,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 2_000_000,
        stdio: ["pipe", "pipe", "pipe"],
        env: testEnv,
      });
      const counts = parseTestCounts(output);
      return { ...counts, output: output.slice(0, 10_000) };
    } catch (err: any) {
      const output = ((err.stdout || "") + (err.stderr || "")).trim();
      const counts = parseTestCounts(output);
      // If we couldn't parse counts, default to 0 passed 1 failed
      if (counts.total === 0) counts.failed = 1;
      counts.total = counts.passed + counts.failed;
      return { ...counts, output: output.slice(0, 10_000) };
    }
  }
  return null;
}

function parseTestCounts(output: string): { passed: number; failed: number; total: number } {
  // Look for "X passed, Y failed out of Z" pattern (our test runner format)
  const match = output.match(/(\d+)\s*passed,?\s*(\d+)\s*failed\s*(?:out of\s*(\d+))?/i);
  if (match) {
    const passed = parseInt(match[1], 10);
    const failed = parseInt(match[2], 10);
    const total = match[3] ? parseInt(match[3], 10) : passed + failed;
    return { passed, failed, total };
  }
  // Fallback: check exit code determined success
  return { passed: 0, failed: 0, total: 0 };
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

function confirmWithOptions(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}
