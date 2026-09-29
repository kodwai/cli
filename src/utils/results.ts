import chalk from "chalk";
import { apiRequest } from "./api.js";
import { display } from "./display.js";

interface Axis {
  name: string;
  points: number;
  score: number;
}

export interface SubmissionView {
  id: string;
  status: string;
  score: number | null;
  challenge_title?: string | null;
  score_breakdown?: {
    overall?: number;
    late_penalty?: number;
    leaderboard_eligible?: boolean;
    ineligible_reason?: string | null;
    axes?: Axis[];
  } | null;
}

const AXIS_LABELS: Record<string, string> = {
  direction: "Direction",
  challenge_rubric: "Challenge rubric",
  outcome: "Outcome",
  lift: "Lift",
};

const INELIGIBLE: Record<string, string> = {
  no_api_key: "Not on the leaderboard: connect your Anthropic API key in Settings so the judge can read your run.",
  invalid_api_key: "Not on the leaderboard: Anthropic rejected your API key. Reconnect a working key in Settings and re-submit.",
  scoring_error: "Not on the leaderboard yet: the judge hit a temporary error. Re-submit to get the full score.",
};

const FINAL = new Set(["scored", "error"]);

function fmt(n: number | null | undefined): string {
  return typeof n === "number" ? (Math.round(n * 10) / 10).toFixed(1) : "–";
}

/**
 * Poll the submission until it's scored (or failed), showing a spinner on a
 * terminal. Returns the final view, or null if it's still scoring at the deadline.
 */
export async function waitForScore(
  baseUrl: string,
  token: string,
  submissionId: string,
  timeoutMs = 6 * 60_000,
): Promise<SubmissionView | null> {
  const deadline = Date.now() + timeoutMs;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const tty = Boolean(process.stdout.isTTY);
  let frame = 0;
  const started = Date.now();
  const spinner = tty
    ? setInterval(() => {
        const secs = Math.round((Date.now() - started) / 1000);
        process.stdout.write(`\r  ${frames[frame++ % frames.length]} Scoring your run... ${secs}s `);
      }, 120)
    : null;
  if (!tty) console.log("  Scoring your run...");

  try {
    while (Date.now() < deadline) {
      try {
        const view = await apiRequest<SubmissionView>(baseUrl, `/api/submissions/${submissionId}`, {
          token,
          timeoutMs: 15_000,
          retries: 1,
        });
        if (FINAL.has(view.status)) return view;
      } catch {
        // transient; keep polling until the deadline
      }
      await new Promise((r) => setTimeout(r, 4_000));
    }
    return null;
  } finally {
    if (spinner) {
      clearInterval(spinner);
      process.stdout.write("\r" + " ".repeat(40) + "\r");
    }
  }
}

/** Print a scored submission as a compact scorecard. */
export function printScorecard(view: SubmissionView, resultsUrl: string): void {
  if (view.status === "error") {
    display.error("Scoring failed on our side. Nothing is lost: your submission is saved.");
    display.info(`  Re-check later or contact support: ${resultsUrl}`);
    return;
  }
  const bd = view.score_breakdown || {};
  const overall = view.score ?? bd.overall ?? null;
  console.log("");
  console.log(`  ${chalk.bold("Score")}  ${chalk.bold(fmt(overall))} ${chalk.dim("/ 100")}`);
  console.log("");
  for (const axis of bd.axes || []) {
    const label = (AXIS_LABELS[axis.name] || axis.name).padEnd(18);
    const ratio = axis.points ? Math.max(0, Math.min(1, axis.score / axis.points)) : 0;
    const bar = "█".repeat(Math.round(ratio * 20)).padEnd(20, "·");
    console.log(`  ${label} ${bar}  ${fmt(axis.score)} / ${fmt(axis.points)}`);
  }
  if (bd.late_penalty) {
    console.log("");
    display.warning(`Late penalty: -${fmt(bd.late_penalty)}`);
  }
  if (bd.leaderboard_eligible === false && bd.ineligible_reason) {
    console.log("");
    display.warning(INELIGIBLE[bd.ineligible_reason] || "Not on the leaderboard for this run.");
  }
  console.log("");
  display.info(`  Full breakdown with the judge's evidence: ${resultsUrl}`);
  console.log("");
}
