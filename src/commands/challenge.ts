import { mkdir, writeFile, stat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, relative, sep } from "node:path";
import { display } from "../utils/display.js";
import { ensureAuth, resolveWebUrl } from "../utils/auth.js";
import { agentLabel, type AgentChoice } from "../traces/detector.js";
import { agentFromEnv, linkEnvSession } from "../traces/linked-sessions.js";
import { ensureCanSubmit } from "../utils/entitlement.js";
import { ensureConsent } from "../utils/consent.js";
import { ensureGit, initWorkspaceRepo } from "../utils/git.js";
import { ApiError, apiRequest, resolveApiUrl } from "../utils/api.js";
import { choose, confirm, isInteractive } from "../utils/prompt.js";
import { findSubmissionMeta, writeSubmissionMeta, type SubmissionMeta } from "../utils/challenge-meta.js";

const AGENTS: { choice: AgentChoice; label: string; aliases: string[] }[] = [
  { choice: "claude-code", label: "Claude Code", aliases: ["claude", "claude-code", "cc"] },
  { choice: "cursor", label: "Cursor", aliases: ["cursor"] },
  { choice: "codex", label: "Codex", aliases: ["codex", "openai"] },
];

/** Map a --agent value to an agent, or null if it isn't one we know. */
export function parseAgent(value: string | undefined): AgentChoice | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return AGENTS.find((a) => a.choice === v || a.aliases.includes(v))?.choice ?? null;
}

/** Keep a starter/test file path inside the workspace (no absolute paths, no ../ escapes). */
export function safeJoin(root: string, filePath: string): string | null {
  if (!filePath || filePath.includes("\0")) return null;
  const target = resolve(root, filePath);
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel.split(sep).includes("..")) return null;
  return target;
}

/** First of kodwai-<slug>, kodwai-<slug>-2, ... that doesn't exist or is an empty directory. */
async function pickWorkspaceDir(base: string, dirName: string): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? dirName : `${dirName}-${i}`;
    const path = join(base, name);
    try {
      const s = await stat(path);
      if (s.isDirectory() && (await readdir(path)).length === 0) return path;
    } catch {
      return path;
    }
  }
  throw new Error(`Too many ${dirName} folders here. Remove old ones or run the command from another folder.`);
}

const WORKSPACE_GITIGNORE = [
  "# kodwai workspace",
  ".kodwai/",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "dist/",
  "build/",
  ".env",
  ".env.*",
  "!.env.example",
  "",
].join("\n");

interface ActiveSubmission {
  id: string;
  challenge_title?: string | null;
  challenge_slug?: string | null;
  started_at: string;
}

/**
 * The API allows one challenge in progress. When one is already running, point
 * at its workspace if it's here, otherwise offer to stop it and start fresh.
 * Returns true when the caller should retry the start.
 */
async function handleActiveChallenge(baseUrl: string, token: string, detail: string): Promise<boolean> {
  let active: ActiveSubmission | null = null;
  try {
    active = await apiRequest<ActiveSubmission | null>(baseUrl, "/api/submissions/active", { token });
  } catch {
    // fall back to the server's message
  }
  console.log("");
  if (!active) {
    display.warning(detail || "You already have a challenge in progress.");
    return false;
  }
  const title = active.challenge_title || active.challenge_slug || "a challenge";
  display.warning(`You already have a challenge in progress: ${title}`);

  const local = await findLocalWorkspace(process.cwd(), active.id);
  if (local) {
    display.info("");
    display.info("  Its workspace is right here. To submit it:");
    display.info(`    cd ${relative(process.cwd(), local) || "."}`);
    display.info("    kodwai submit");
    display.info("");
    display.info("  Or drop it and start over with: kodwai abandon");
    console.log("");
    return false;
  }
  if (!isInteractive()) {
    display.info("  Submit it from its workspace with `kodwai submit`, or drop it with `kodwai abandon`.");
    console.log("");
    return false;
  }
  const drop = await confirm(`  Abandon "${title}" and start this one instead? (y/N) `);
  if (!drop) {
    display.info("  Kept it. Submit it from its workspace with `kodwai submit`.");
    console.log("");
    return false;
  }
  await apiRequest(baseUrl, `/api/submissions/${active.id}`, { method: "DELETE", token });
  display.success(`Abandoned "${title}".`);
  return true;
}

/** A kodwai-* folder in `dir` (or `dir` itself) whose metadata points at `submissionId`. */
async function findLocalWorkspace(dir: string, submissionId: string): Promise<string | null> {
  const here = await findSubmissionMeta(dir);
  if (here?.meta.submission_id === submissionId) return here.workspacePath;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("kodwai-")) continue;
      const found = await findSubmissionMeta(join(dir, entry.name));
      if (found?.meta.submission_id === submissionId && found.workspacePath === join(dir, entry.name)) {
        return found.workspacePath;
      }
    }
  } catch {
    // unreadable cwd
  }
  return null;
}

export interface ChallengeOptions {
  /** Accept the data collection notice without a prompt (the user agreed in their agent's chat). */
  acceptNotice?: boolean;
}

export async function startChallenge(
  idOrSlug: string,
  apiUrl?: string,
  agentFlag?: string,
  opts: ChallengeOptions = {},
): Promise<void> {
  const baseUrl = resolveApiUrl(apiUrl);

  display.banner();

  let agentChoice = parseAgent(agentFlag);
  if (agentFlag && !agentChoice) {
    throw new Error(`Unknown agent "${agentFlag}". Use one of: claude-code, cursor, codex.`);
  }
  // Run by an agent (no terminal): it's the agent whose environment we're in.
  if (!agentChoice && !isInteractive()) agentChoice = agentFromEnv();
  // Check before starting: the clock starts server-side on start.
  if (!agentChoice && !isInteractive()) {
    throw new Error("Pass --agent claude-code|cursor|codex when running without a terminal.");
  }

  // Starting inside another challenge's workspace would nest one repo in another.
  const nested = await findSubmissionMeta(process.cwd());
  if (nested) {
    throw new Error(
      `You're inside the workspace for "${nested.meta.challenge_slug}" (${nested.workspacePath}).\n` +
        "   cd out of it first, then start the new challenge.",
    );
  }

  // 0. First-run consent, and git (needed for tracking changes & scoring)
  await ensureConsent(opts.acceptNotice);
  ensureGit();

  display.info("Connecting to kodwai...\n");

  // 1. Authenticate, then make sure they can still submit before they invest time.
  const token = await ensureAuth(baseUrl);
  if (!(await ensureCanSubmit(baseUrl))) return;

  // 2. Start submission via API
  display.info("Loading challenge...");
  let data: { submission_id: string; challenge: any };
  const start = () =>
    apiRequest(baseUrl, `/api/challenges/${encodeURIComponent(idOrSlug)}/start`, {
      method: "POST",
      token,
      retries: 0, // not idempotent: a retry after a lost response would hit "already in progress"
      fallbackError: "Failed to start challenge",
    });
  try {
    data = await start();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      if (!(await handleActiveChallenge(baseUrl, token, e.message))) return;
      data = await start();
    } else if (e instanceof ApiError && e.status === 404) {
      throw new Error(
        `No challenge called "${idOrSlug}". Browse challenges at ${resolveWebUrl(baseUrl)}/dev/challenges`,
      );
    } else {
      throw e;
    }
  }
  const { submission_id, challenge } = data;

  display.success(`Challenge: ${challenge.title}`);

  // 3. Which agent will they use?
  if (!agentChoice) {
    const idx = await choose("Which agent will you use?", AGENTS);
    agentChoice = AGENTS[idx].choice;
  }

  // 4. Create workspace (never reuse a non-empty folder)
  const safeName =
    challenge.slug ||
    String(challenge.title || "challenge").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const workspacePath = await pickWorkspaceDir(process.cwd(), `kodwai-${safeName}`);
  const dirName = relative(process.cwd(), workspacePath);
  await mkdir(workspacePath, { recursive: true });

  await writeFile(
    join(workspacePath, "PROBLEM.md"),
    `# ${challenge.title}\n\n${challenge.problem_statement_md}\n`,
    "utf-8",
  );

  // Starter files and tests. Paths come from the server; keep them inside the workspace.
  const files: { path: string; content: string }[] = [];
  for (const f of Array.isArray(challenge.starter_files) ? challenge.starter_files : []) {
    if (f?.path) files.push({ path: f.path, content: f.content || "" });
  }
  for (const t of Array.isArray(challenge.test_suite) ? challenge.test_suite : []) {
    if (t?.file_path && t.content) files.push({ path: t.file_path, content: t.content });
  }
  for (const f of files) {
    const target = safeJoin(workspacePath, f.path);
    if (!target) {
      display.warning(`Skipped a starter file with an unsafe path: ${f.path}`);
      continue;
    }
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, f.content, "utf-8");
  }

  // A package.json isolates the workspace from a parent project's module system.
  await writeIfMissing(
    join(workspacePath, "package.json"),
    JSON.stringify({ name: `kodwai-${safeName}`, version: "1.0.0", private: true }, null, 2) + "\n",
  );
  // Keeps dependencies, secrets and our own metadata out of git and out of the submission.
  await writeIfMissing(join(workspacePath, ".gitignore"), WORKSPACE_GITIGNORE);

  // Git repo with one starter commit: the baseline the submission diff is taken against.
  try {
    initWorkspaceRepo(workspacePath);
  } catch (e) {
    const msg = (e as any)?.stderr?.toString?.().trim() || (e as Error).message;
    display.warning(`Couldn't create the starter git commit (${msg.split("\n")[0]}). Continuing without it.`);
  }

  // Submission metadata (inside .kodwai/, which is gitignored)
  const meta: SubmissionMeta = {
    submission_id,
    challenge_id: challenge.id,
    challenge_slug: challenge.slug,
    challenge_title: challenge.title,
    agent_choice: agentChoice,
    started_at: new Date().toISOString(),
    workspace_path: workspacePath,
    api_url: baseUrl,
    time_limit_minutes: challenge.time_limit_minutes,
    test_suite: challenge.test_suite,
  };
  await mkdir(join(workspacePath, ".kodwai"), { recursive: true });
  await writeSubmissionMeta(join(workspacePath, ".kodwai", "submission.json"), meta);
  // Started from inside the agent: link this session so submit reads its exact transcript.
  const linked = await linkEnvSession(workspacePath, agentChoice, "challenge");

  display.success(`Workspace ready: ${dirName}/`);

  // 5. Problem statement + next steps
  display.divider();
  display.problemStatement(challenge.problem_statement_md);
  display.divider();

  const label = agentLabel(agentChoice);
  display.info(`⏱  Time limit: ${challenge.time_limit_minutes} minutes (the clock is running)`);
  display.info(`🔧  Agent: ${label}`);
  display.info("");
  display.info("  Next:");
  if (linked) {
    display.info(`    This ${label} session is linked to the challenge. Keep going in it,`);
    display.info(`    and keep your work inside ${dirName}/.`);
  } else {
    display.info(`    cd ${dirName}`);
    display.info(`    Open it with ${label} and start building.`);
  }
  display.info("");
  display.info("  Anytime:  kodwai status   (time left, files so far)");
  display.info("  Done:     kodwai submit");
  display.info("");
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    await writeFile(path, content, "utf-8");
  }
}
