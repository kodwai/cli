import { fetchSessionConfig, type SessionConfig } from "../session/config.js";
import { createWorkspace } from "../session/workspace.js";
import { launchClaude } from "../session/claude.js";
import { createTimer } from "../session/timer.js";
import { createEventSender } from "../streaming/event-sender.js";
import { createFileWatcher } from "../streaming/file-watcher.js";
import { createTranscriptWatcher } from "../streaming/transcript-watcher.js";
import { display } from "../utils/display.js";

const DEFAULT_API_URL = "https://api.kodwai.com";

export async function startSession(sessionId: string, apiUrl?: string, sessionToken?: string): Promise<void> {
  const baseUrl = apiUrl || process.env.KODWAI_API_URL || DEFAULT_API_URL;

  display.banner();
  display.info("Connecting to Kodwai...");

  // 1. Fetch session config
  const config = await fetchSessionConfig(sessionId, baseUrl, sessionToken);
  display.success(`Session loaded: ${config.project_title}`);

  // 2. Create workspace
  const workspacePath = await createWorkspace(config);
  display.success(`Workspace ready: ${workspacePath}`);

  // 3. Set up event streaming
  const eventSender = createEventSender(sessionId, config.webhook_secret, baseUrl);

  // 4. Set up file watcher and JSONL transcript watcher
  const fileWatcher = createFileWatcher(workspacePath, sessionId, config.webhook_secret, baseUrl);
  const transcriptWatcher = createTranscriptWatcher(workspacePath, sessionId, config.webhook_secret, baseUrl);

  // 5. Show problem statement and start timer
  display.divider();
  display.problemStatement(config.problem_statement_md);
  display.divider();

  const timer = createTimer(config.time_limit_minutes, () => {});

  const budgetStr = config.max_budget_usd ? ` | Budget: $${config.max_budget_usd.toFixed(2)}` : "";
  display.info(`⏱  ${config.time_limit_minutes} minutes${budgetStr} — timer started`);
  display.info("Type /exit in Claude Code when you're done.\n");

  // 6. Start time-warnings monitor (budget warnings come from proxy 402s)
  let warningShown5min = false;
  let warningShown1min = false;

  const warningInterval = setInterval(() => {
    const remaining = timer.remaining();
    const remainingMin = remaining / 60000;

    if (remainingMin <= 1 && !warningShown1min) {
      warningShown1min = true;
      display.warning("\n⚠  1 minute remaining!");
    } else if (remainingMin <= 5 && !warningShown5min) {
      warningShown5min = true;
      display.warning("\n⚠  5 minutes remaining!");
    }
  }, 30000);

  // Prevent Ctrl+C from killing before upload completes
  let ending = false;
  process.on("SIGINT", async () => {
    if (ending) return;
    ending = true;
    clearInterval(warningInterval);
    display.info("\nCaught interrupt — uploading session data before exit...");
    await endSession(sessionId, config, eventSender, fileWatcher, transcriptWatcher, workspacePath, baseUrl, "candidate_finished");
  });

  // 7. Launch Claude Code
  try {
    const result = await launchClaude(config, workspacePath, eventSender, timer, baseUrl);

    clearInterval(warningInterval);

    if (result.reason === "candidate_finished") {
      display.success("\n✅ You ended the session.");
    } else if (result.reason === "timer_expired") {
      display.warning("\n⏰ Time's up! Finishing session...");
    } else if (result.reason === "budget_exceeded") {
      display.warning("\n💰 API budget limit reached.");
    }

    await endSession(sessionId, config, eventSender, fileWatcher, transcriptWatcher, workspacePath, baseUrl, result.reason, result);
  } catch (err) {
    clearInterval(warningInterval);
    const message = err instanceof Error ? err.message : "Unknown error";
    display.error(`\nSession error: ${message}`);
    await endSession(sessionId, config, eventSender, fileWatcher, transcriptWatcher, workspacePath, baseUrl, "error");
  }
}

async function endSession(
  sessionId: string,
  config: SessionConfig,
  eventSender: ReturnType<typeof createEventSender>,
  fileWatcher: ReturnType<typeof createFileWatcher>,
  transcriptWatcher: ReturnType<typeof createTranscriptWatcher>,
  workspacePath: string,
  baseUrl: string,
  reason: string,
  result?: { totalCostUsd?: number; totalTokens?: number },
): Promise<void> {
  display.info("Uploading session data...");

  fileWatcher.stop();
  transcriptWatcher.stop();
  // Give the watcher's final scan a moment to fire so the last response lands
  await new Promise((r) => setTimeout(r, 500));
  await eventSender.flush();

  const endPayload = {
    end_reason: reason,
    total_cost_usd: result?.totalCostUsd ?? null,
    total_tokens: result?.totalTokens ?? null,
  };

  try {
    await eventSender.sendEnd(endPayload);
    display.success("Session data uploaded.");
  } catch {
    display.warning("Failed to upload final session data. Your work is saved locally.");
  }

  display.divider();
  display.info("Thank you for interviewing with Kodwai!");
  display.info(`Your workspace is at: ${workspacePath}\n`);

  process.exit(0);
}
