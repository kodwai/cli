import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { display } from "../utils/display.js";
import { ensureAuth, promptChoice } from "../utils/auth.js";
import { agentLabel } from "../traces/detector.js";
import { ensureCanSubmit } from "../utils/entitlement.js";
import { ensureConsent } from "../utils/consent.js";
import { ensureGit } from "../utils/git.js";

const DEFAULT_API_URL = "https://api.kodwai.com";

export async function startChallenge(idOrSlug: string, apiUrl?: string): Promise<void> {
  const baseUrl = apiUrl || process.env.KODWAI_API_URL || DEFAULT_API_URL;

  display.banner();

  // 0. First-run consent
  await ensureConsent();

  // 0b. Ensure git is installed (needed for tracking changes & scoring)
  ensureGit();

  display.info("Connecting to kodwai...\n");

  // 1. Authenticate
  const token = await ensureAuth(baseUrl);

  // 1b. Make sure they can still submit before they invest time coding.
  if (!(await ensureCanSubmit(baseUrl))) return;

  // 2. Start submission via API
  display.info("Loading challenge...");
  const resp = await fetch(`${baseUrl}/api/challenges/${idOrSlug}/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: "Failed to start challenge" }));
    // 409 = a challenge is already in progress (one at a time). Show it cleanly, don't crash.
    if (resp.status === 409) {
      console.log("");
      display.warning(err.detail || "You already have a challenge in progress.");
      console.log("");
      return;
    }
    throw new Error(err.detail || "Failed to start challenge");
  }

  const data = await resp.json();
  const { submission_id, challenge } = data;

  display.success(`Challenge: ${challenge.title}`);

  // 3. Ask which agent they'll use
  const agentIdx = await promptChoice("Which agent will you use?", [
    "Claude Code",
    "Cursor",
    "Codex",
  ]);
  const agentChoice = (["claude-code", "cursor", "codex"] as const)[agentIdx];

  // 4. Create workspace
  const safeName = challenge.slug || challenge.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dirName = `kodwai-${safeName}`;
  const workspacePath = join(process.cwd(), dirName);

  await mkdir(workspacePath, { recursive: true });

  // Write problem statement
  await writeFile(
    join(workspacePath, "PROBLEM.md"),
    `# ${challenge.title}\n\n${challenge.problem_statement_md}\n`,
    "utf-8",
  );

  // Write a package.json to isolate the workspace from parent module system
  const pkgJsonPath = join(workspacePath, "package.json");
  try {
    await stat(pkgJsonPath);
    // Already exists from starter files — don't overwrite
  } catch {
    await writeFile(pkgJsonPath, JSON.stringify({ name: `kodwai-${safeName}`, version: "1.0.0", private: true }, null, 2) + "\n", "utf-8");
  }

  // Write starter files if any
  if (challenge.starter_files && Array.isArray(challenge.starter_files)) {
    for (const file of challenge.starter_files) {
      const filePath = join(workspacePath, file.path);
      const dir = join(filePath, "..");
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, file.content || "", "utf-8");
    }
  }

  // Write test suite files if any
  if (challenge.test_suite && Array.isArray(challenge.test_suite)) {
    for (const test of challenge.test_suite) {
      if (test.file_path && test.content) {
        const testPath = join(workspacePath, test.file_path);
        const dir = join(testPath, "..");
        await mkdir(dir, { recursive: true });
        await writeFile(testPath, test.content, "utf-8");
      }
    }
  }

  // Init git repo (git is guaranteed by ensureGit() above)
  execSync("git init", { cwd: workspacePath, stdio: "ignore" });
  execSync("git add -A", { cwd: workspacePath, stdio: "ignore" });
  execSync('git commit -m "Initial: challenge starter files"', { cwd: workspacePath, stdio: "ignore" });

  // Write submission metadata
  const kodwaiDir = join(workspacePath, ".kodwai");
  await mkdir(kodwaiDir, { recursive: true });
  await writeFile(
    join(kodwaiDir, "submission.json"),
    JSON.stringify(
      {
        submission_id,
        challenge_id: challenge.id,
        challenge_slug: challenge.slug,
        agent_choice: agentChoice,
        started_at: new Date().toISOString(),
        workspace_path: workspacePath,
        api_url: baseUrl,
        time_limit_minutes: challenge.time_limit_minutes,
        test_suite: challenge.test_suite,
      },
      null,
      2,
    ),
    "utf-8",
  );

  display.success(`Workspace ready: ${dirName}/`);

  // 5. Display problem statement
  display.divider();
  display.problemStatement(challenge.problem_statement_md);
  display.divider();

  const agentLabelText = agentLabel(agentChoice);
  display.info(`⏱  Time limit: ${challenge.time_limit_minutes} minutes`);
  display.info(`🔧  Agent: ${agentLabelText}`);
  display.info("");
  display.info(`  cd ${dirName}`);
  display.info(`  Open the project with ${agentLabelText} and start coding!`);
  display.info("");
  display.info("  When you're done, run:");
  display.info(`    kodwai submit`);
  display.info("");
}
