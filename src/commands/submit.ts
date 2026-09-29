import { execSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { display } from "../utils/display.js";
import { ensureAuth, getCurrentUser, resolveWebUrl } from "../utils/auth.js";
import { ensureCanSubmit } from "../utils/entitlement.js";
import { detectAndCollectTrace } from "../traces/detector.js";
import { ApiError, apiRequest } from "../utils/api.js";
import { collectGitData } from "../utils/git.js";
import { collectWorkspaceFiles, countSourceFiles, summarizeFiles } from "../utils/collect.js";
import { elapsed, findSubmissionMeta, writeSubmissionMeta } from "../utils/challenge-meta.js";
import { confirm, ask, isInteractive } from "../utils/prompt.js";
import { printScorecard, waitForScore, type SubmissionView } from "../utils/results.js";

export interface SubmitOptions {
  /** Skip the confirmation prompt (needed when there's no terminal). */
  yes?: boolean;
  /** Don't wait for the score; print the results link and exit. */
  noWait?: boolean;
}

const ALREADY_SUBMITTED = "Submission already submitted";

export async function submitChallenge(opts: SubmitOptions = {}): Promise<void> {
  display.banner();

  // 1. Find the workspace from wherever we are inside it.
  const found = await findSubmissionMeta(process.cwd());
  if (!found) {
    throw new Error(
      "No challenge workspace here. Run `kodwai challenge <slug>` first, then cd into the kodwai-<slug> folder it creates.",
    );
  }
  const { meta, metaPath, workspacePath } = found;
  const baseUrl = meta.api_url;
  const resultsUrl = `${resolveWebUrl(baseUrl)}/dev/submissions/${meta.submission_id}`;

  if (meta.submitted_at) {
    display.info(`This challenge was already submitted (${new Date(meta.submitted_at).toLocaleString()}).`);
    const token = await ensureAuth(baseUrl);
    await showResult(baseUrl, token, meta.submission_id, resultsUrl, opts.noWait);
    return;
  }

  // 2. Sign in first, so a browser sign-in never interrupts the upload step.
  const token = await ensureAuth(baseUrl);
  if (!(await ensureCanSubmit(baseUrl))) return;

  const time = elapsed(meta);
  if (time.late) {
    display.warning(`Time limit exceeded by ${time.minutes - time.limitMinutes} min (${time.minutes}/${time.limitMinutes} min)`);
    display.warning("You can still submit, but a late penalty will be applied to your score.");
  } else {
    display.info(`Time: ${time.minutes}/${time.limitMinutes} min`);
  }

  // 3. Code
  display.info("Collecting files...");
  const collected = await collectWorkspaceFiles(workspacePath);
  const codeSnapshot = collected.files;
  display.success(`${codeSnapshot.length} files collected${codeSnapshot.length ? `: ${summarizeFiles(codeSnapshot)}` : ""}`);
  if (collected.secrets.length) {
    display.info(`  Left out ${collected.secrets.length} secret file(s): ${collected.secrets.slice(0, 5).join(", ")}`);
  }
  if (collected.tooLarge.length) {
    display.warning(`Left out ${collected.tooLarge.length} file(s) over 500 KB: ${collected.tooLarge.slice(0, 5).join(", ")}`);
  }
  if (collected.overCap) {
    display.warning(`Left out ${collected.overCap} file(s) past the size limit. Add build output and data to .gitignore.`);
  }

  // 4. Git: everything changed since the starter commit, plus the commit log.
  const tmpIndex = join(tmpdir(), `kodwai-index-${randomBytes(6).toString("hex")}`);
  const gitData = collectGitData(workspacePath, tmpIndex);
  await rm(tmpIndex, { force: true }).catch(() => {});
  if (gitData.log.length) display.success(`${gitData.log.length} git commit${gitData.log.length === 1 ? "" : "s"} collected`);
  else display.info("No git history available");

  // 5. Tests, when the challenge ships a suite
  let testResults: TestResults | null = null;
  if (meta.test_suite && meta.test_suite.length > 0) {
    display.info("Running tests...");
    testResults = runLocalTests(workspacePath, meta.test_suite);
    if (testResults) {
      const status = testResults.failed === 0 && testResults.total > 0 ? "✓" : "⚠";
      display.info(`${status} Tests: ${testResults.passed}/${testResults.total} passed`);
    }
  }

  // 6. Agent traces
  display.info(`Collecting ${meta.agent_choice} traces...`);
  const startTime = new Date(meta.started_at);
  const detection = await detectAndCollectTrace(meta.agent_choice, startTime, workspacePath);
  if (detection.trace) {
    const modelSuffix = detection.trace.model_raw ? ` · ${detection.trace.model_raw}` : "";
    display.success(`Agent: ${detection.agent}${modelSuffix} (${detection.trace.trace_quality} quality, ${detection.trace.turns.length} turns)`);
  } else {
    display.warning(`No ${meta.agent_choice} traces found for this folder since the challenge started.`);
    display.info("  Direction is read from the trace, so it will score low. Did you run the agent inside this folder?");
  }

  const body = {
    code_snapshot: codeSnapshot,
    git_diff: gitData.diff,
    git_log: gitData.log,
    test_results: testResults,
    agent_used: detection.agent,
    model_raw: detection.trace?.model_raw,
    model_provider: detection.trace?.model_provider,
    agent_trace: detection.trace,
    time_taken_ms: time.ms,
  };
  const payload = JSON.stringify(body);

  // 7. Summary + confirm
  const sourceCount = countSourceFiles(codeSnapshot);
  display.divider();
  console.log("");
  console.log("  SUBMISSION SUMMARY");
  console.log("");
  console.log(`  Challenge:     ${meta.challenge_title || meta.challenge_slug}`);
  console.log(`  Workspace:     ${workspacePath}`);
  console.log(`  Files:         ${codeSnapshot.length} (${sourceCount} source) from this folder only`);
  console.log(`  Commits:       ${gitData.log.length}`);
  console.log(`  Tests:         ${testResults ? `${testResults.passed}/${testResults.total} passed` : "none"}`);
  console.log(`  Agent traces:  ${detection.trace?.turns.length || 0} turns from ${detection.agent} (this session only)`);
  console.log(`  Time:          ${time.minutes}/${time.limitMinutes} min${time.late ? " (LATE, penalty will apply)" : ""}`);
  console.log(`  Payload size:  ~${Math.round(payload.length / 1024)} KB`);
  console.log("");
  console.log("  No files outside the challenge directory were accessed.");
  console.log("  Only AI traces from this challenge session are included.");
  console.log("");
  if (sourceCount === 0) {
    display.warning("No source code files found in this folder. You can only submit a challenge once.");
    console.log("");
  }

  if (!opts.yes) {
    if (!isInteractive()) {
      throw new Error("Run `kodwai submit --yes` to submit without a terminal prompt.");
    }
    let answer = (await ask("  Submit (y), view files (v), or cancel (n)? ")).toLowerCase();
    if (answer === "v") {
      console.log("\n  --- FILES ---");
      for (const f of codeSnapshot) console.log(`    ${f.path} (${f.content.length} chars)`);
      if (detection.trace && detection.trace.turns.length > 0) {
        console.log("\n  --- AGENT TRACE (first 5 turns) ---");
        for (const turn of detection.trace.turns.slice(0, 5)) {
          const preview = turn.content.slice(0, 120).replace(/\n/g, " ");
          console.log(`    [${turn.role}] ${preview}${turn.content.length > 120 ? "..." : ""}`);
        }
        if (detection.trace.turns.length > 5) console.log(`    ... and ${detection.trace.turns.length - 5} more turns`);
      }
      console.log("");
      answer = (await confirm("  Submit now? (y/N) ")) ? "y" : "n";
    }
    if (answer !== "y" && answer !== "yes") {
      display.info("Submission cancelled. Nothing was sent.");
      return;
    }
  }

  // 8. Upload. Retrying is safe: the API accepts a submission exactly once and
  // answers any repeat with "already submitted".
  display.info("Uploading submission...");
  try {
    await apiRequest<SubmissionView>(baseUrl, `/api/submissions/${meta.submission_id}/submit`, {
      method: "POST",
      token,
      body,
      timeoutMs: 180_000,
      retries: 2,
      fallbackError: "Submission failed",
    });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 400 && e.message === ALREADY_SUBMITTED)) {
      if (e instanceof ApiError && e.status === 404) {
        throw new Error("The API doesn't know this challenge run (it may have been abandoned). Start it again with `kodwai challenge`.");
      }
      throw e;
    }
    // Our earlier attempt got through (or it was submitted before): treat as done.
  }

  meta.submitted_at = new Date().toISOString();
  await writeSubmissionMeta(metaPath, meta).catch(() => {});
  display.success("Submission received!");

  await showResult(baseUrl, token, meta.submission_id, resultsUrl, opts.noWait);
  await printFreeTierStatus(baseUrl);
}

async function showResult(baseUrl: string, token: string, id: string, resultsUrl: string, noWait?: boolean) {
  if (noWait) {
    display.info(`  Scoring in progress. Results: ${resultsUrl}`);
    console.log("");
    return;
  }
  const view = await waitForScore(baseUrl, token, id);
  if (view) {
    printScorecard(view, resultsUrl);
  } else {
    display.info("  Still scoring (the judge reads your whole session, it can take a few minutes).");
    display.info(`  Results will appear here: ${resultsUrl}`);
    display.info("  Or run `kodwai status` in this folder later.");
    console.log("");
  }
}

async function printFreeTierStatus(baseUrl: string): Promise<void> {
  try {
    const me = await getCurrentUser(baseUrl);
    if (me && me.user_type === "developer" && !me.has_claude_api_key && (me.free_submissions_limit ?? 0) > 0) {
      const settings = `${resolveWebUrl(baseUrl)}/dev/settings`;
      const left = me.free_submissions_remaining ?? 0;
      if (left > 0) {
        display.info(`  ${left} free submission${left !== 1 ? "s" : ""} left. Add your Anthropic key for unlimited: ${settings}`);
      } else {
        display.warning("That was your last free submission.");
        display.info(`  Connect your Anthropic API key to keep going: ${settings}`);
      }
      console.log("");
    }
  } catch {
    // best-effort
  }
}

interface TestResults {
  passed: number;
  failed: number;
  total: number;
  output: string;
}

function runLocalTests(workspacePath: string, testSuite: any[]): TestResults | null {
  // A random high port avoids clashing with anything the developer has running.
  const testPort = 10000 + Math.floor(Math.random() * 50000);
  const testEnv = { ...process.env, PORT: String(testPort), TEST_PORT: String(testPort), CI: "1" };

  for (const test of testSuite) {
    if (!test.command) continue;
    try {
      const output = execSync(test.command, {
        cwd: workspacePath,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 5_000_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: testEnv,
      });
      const counts = parseTestCounts(output);
      return { ...counts, output: output.slice(-10_000) };
    } catch (err: any) {
      const output = ((err.stdout || "") + (err.stderr || "")).trim();
      const counts = parseTestCounts(output);
      if (counts.total === 0) counts.failed = 1;
      counts.total = counts.passed + counts.failed;
      return { ...counts, output: output.slice(-10_000) };
    }
  }
  return null;
}

/**
 * Pull pass/fail counts out of common runners' summaries: our own runner
 * ("X passed, Y failed out of Z"), pytest, jest/vitest, bun, mocha, go test.
 */
export function parseTestCounts(output: string): { passed: number; failed: number; total: number } {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const num = (re: RegExp): number | null => {
    const all = [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
    return all.length ? Number.parseInt(all[all.length - 1][1], 10) : null;
  };

  const ours = text.match(/(\d+)\s*passed,?\s*(\d+)\s*failed\s*(?:out of\s*(\d+))?/i);
  if (ours) {
    const passed = Number.parseInt(ours[1], 10);
    const failed = Number.parseInt(ours[2], 10);
    return { passed, failed, total: ours[3] ? Number.parseInt(ours[3], 10) : passed + failed };
  }

  // jest / vitest: "Tests:  1 failed, 12 passed, 13 total" / "Tests  12 passed (12)"
  const testsLine = text.split("\n").reverse().find((l) => /^\s*Tests:?\s/.test(l));
  if (testsLine) {
    const passed = Number.parseInt(testsLine.match(/(\d+)\s+passed/)?.[1] ?? "0", 10);
    const failed = Number.parseInt(testsLine.match(/(\d+)\s+failed/)?.[1] ?? "0", 10);
    if (passed + failed > 0) return { passed, failed, total: passed + failed };
  }

  // bun: " 12 pass" / " 1 fail"
  const bunPass = num(/^\s*(\d+)\s+pass\s*$/m);
  const bunFail = num(/^\s*(\d+)\s+fail\s*$/m);
  if (bunPass !== null || bunFail !== null) {
    const passed = bunPass ?? 0;
    const failed = bunFail ?? 0;
    return { passed, failed, total: passed + failed };
  }

  // pytest / mocha: "5 passed, 1 failed in 0.2s" / "5 passing" "1 failing"
  const passed = num(/(\d+)\s+(?:passed|passing)\b/i);
  const failed = num(/(\d+)\s+(?:failed|failing)\b/i);
  if (passed !== null || failed !== null) {
    return { passed: passed ?? 0, failed: failed ?? 0, total: (passed ?? 0) + (failed ?? 0) };
  }

  // go test: "--- PASS:" / "--- FAIL:" lines
  const goPass = (text.match(/^--- PASS:/gm) || []).length;
  const goFail = (text.match(/^--- FAIL:/gm) || []).length;
  if (goPass + goFail > 0) return { passed: goPass, failed: goFail, total: goPass + goFail };

  return { passed: 0, failed: 0, total: 0 };
}
