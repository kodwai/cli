import chalk from "chalk";
import { ApiError } from "../utils/api.js";
import { authedCtx, get, send, query, intFlag, type CtxOptions, type Ctx } from "../utils/context.js";
import { table, num, int, bar, day, heading, line, blank, printJson, minutes, AXIS_LABELS, AXIS_SHORT, weightShares } from "../utils/format.js";
import { display } from "../utils/display.js";
import { findSubmissionMeta } from "../utils/challenge-meta.js";
import { confirm, isInteractive } from "../utils/prompt.js";

interface Signal {
  name: string;
  value: number | null;
  weight: number;
  reason?: string | null;
  evidence?: string[];
  skipped?: boolean;
}

interface Axis {
  name: string;
  points: number;
  score: number;
  signals?: Signal[];
}

export interface Submission {
  id: string;
  challenge_id: string;
  status: string;
  score: number | null;
  agent_used?: string | null;
  model_display?: string | null;
  time_taken_ms?: number | null;
  turns?: number | null;
  total_tokens?: number | null;
  started_at?: string | null;
  submitted_at?: string | null;
  scored_at?: string | null;
  created_at?: string | null;
  challenge_title?: string | null;
  challenge_slug?: string | null;
  challenge_difficulty?: string | null;
  challenge_time_limit_minutes?: number | null;
  score_breakdown?: {
    overall?: number;
    late_penalty?: number;
    leaderboard_eligible?: boolean;
    ineligible_reason?: string | null;
    confidence?: string | null;
    trace_quality?: string | null;
    baseline_lift?: { beat?: boolean; delta?: number; L?: number } | null;
    axes?: Axis[];
    objective?: { total?: number };
    analytical?: { total?: number; strengths?: string[]; weaknesses?: string[] };
  } | null;
  moments?: { kind: string; glyph: string; label: string; detail?: string; axis?: string; signal?: string }[];
  celebration?: {
    personal_best?: boolean;
    first_run?: boolean;
    tier_up?: { from?: string; to?: string; name?: string } | null;
    new_badges?: { name: string; icon?: string }[];
    streak?: number;
    streak_milestone?: number | null;
  } | null;
}

const INELIGIBLE: Record<string, string> = {
  no_api_key: "not on the leaderboard: connect your own Anthropic key (kodwai key add) so the judge can read your run",
  invalid_api_key: "not on the leaderboard: Anthropic rejected your key. Reconnect a working one (kodwai key add) and re-submit",
  scoring_error: "not on the leaderboard yet: the judge hit a temporary error. Re-submit for the full score",
};

function axesText(s: Submission): string {
  const axes = s.score_breakdown?.axes ?? [];
  return axes.map((a) => `${AXIS_SHORT[a.name] || a.name[0].toUpperCase()}${int(a.score)}`).join(" ");
}

export interface SubmissionsOptions extends CtxOptions {
  challenge?: string;
  limit?: string;
  page?: string;
}

/** kodwai submissions: your run history. */
export async function submissions(opts: SubmissionsOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  let challengeId: string | undefined;
  if (opts.challenge) {
    try {
      challengeId = (await get<{ id: string }>(ctx, `/api/challenges/${encodeURIComponent(opts.challenge)}`)).id;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new Error(`No challenge called "${opts.challenge}".`);
      throw e;
    }
  }
  const limit = intFlag("--limit", opts.limit, 20);
  const page = intFlag("--page", opts.page, 1, 1, 1000);
  const list = await get<Submission[]>(ctx, `/api/submissions/me${query({ challenge_id: challengeId, limit, page })}`);
  if (ctx.json) return printJson(list);
  if (list.length === 0) {
    display.info("\n  No runs yet. Pick a challenge: kodwai challenges\n");
    return;
  }
  const scored = list.filter((s) => s.status === "scored" && typeof s.score === "number");
  heading(`Your runs${opts.challenge ? ` · ${opts.challenge}` : ""}`);
  const best = scored.length ? Math.max(...scored.map((s) => s.score as number)) : null;
  display.info(`  ${list.length} shown · ${scored.length} scored · best ${num(best)}`);
  blank();
  console.log(
    table(list, [
      { header: "DATE", value: (s) => day(s.scored_at || s.submitted_at || s.created_at) },
      { header: "CHALLENGE", value: (s) => s.challenge_slug || s.challenge_title || "–", max: 36 },
      { header: "STATUS", value: (s) => (s.status === "scored" ? s.status : chalk.yellow(s.status)) },
      { header: "AGENT", value: (s) => s.agent_used || "–" },
      { header: "TIME", value: (s) => minutes(s.time_taken_ms), align: "right" },
      { header: "AXES", value: (s) => axesText(s) },
      { header: "SCORE", value: (s) => num(s.score), align: "right" },
      { header: "ID", value: (s) => chalk.dim(s.id) },
    ]),
  );
  blank();
  display.info("  One run in full: kodwai result <id>");
  if (list.length === limit) display.info(`  More: kodwai submissions --page ${page + 1}`);
  blank();
}

/** The run to act on: the given id, the workspace's run, or your latest. */
async function resolveSubmissionId(ctx: Ctx, id: string | undefined): Promise<string> {
  if (id) return id;
  const found = await findSubmissionMeta(process.cwd());
  if (found) return found.meta.submission_id;
  const latest = await get<Submission[]>(ctx, `/api/submissions/me${query({ limit: 1 })}`);
  if (!latest.length) throw new Error("No runs yet. Pick a challenge: kodwai challenges");
  return latest[0].id;
}

async function fetchSubmission(ctx: Ctx, id: string): Promise<Submission> {
  try {
    return await get<Submission>(ctx, `/api/submissions/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`No run "${id}" on your account. List them with: kodwai submissions`);
    throw e;
  }
}

/** kodwai result [id]: one run in full: score, axes, moments, what it unlocked, and (--verbose) every signal with its evidence. */
export async function result(id: string | undefined, opts: CtxOptions & { verbose?: boolean }): Promise<void> {
  const ctx = await authedCtx(opts);
  const s = await fetchSubmission(ctx, await resolveSubmissionId(ctx, id));
  if (ctx.json) return printJson(s);
  const url = `${ctx.webUrl}/dev/submissions/${s.id}`;

  heading(`${s.challenge_title || s.challenge_slug || "Run"}${chalk.dim(`  ${s.id}`)}`);
  blank();
  line("Status", s.status);
  line("Agent", [s.agent_used, s.model_display].filter(Boolean).join(" · ") || "–");
  const limitMin = s.challenge_time_limit_minutes;
  line("Time", `${minutes(s.time_taken_ms)}${limitMin ? ` of ${limitMin}m` : ""}${s.turns ? ` · ${s.turns} turns` : ""}`);
  line("Date", day(s.scored_at || s.submitted_at || s.created_at));

  if (s.status !== "scored") {
    blank();
    if (s.status === "in_progress") display.info("  Still in progress. Submit from its workspace: kodwai submit");
    else if (s.status === "error") display.warning("Scoring failed on our side. The submission is saved.");
    else display.info(`  Scoring now. Check again in a minute: kodwai result ${s.id}`);
    blank();
    return;
  }

  const bd = s.score_breakdown ?? {};
  heading(`Score  ${chalk.bold(num(s.score ?? bd.overall))} ${chalk.dim("/ 100")}`);
  for (const axis of bd.axes ?? []) {
    const label = (AXIS_LABELS[axis.name] || axis.name).padEnd(18);
    console.log(`  ${label} ${bar(axis.points ? axis.score / axis.points : 0)}  ${num(axis.score)} / ${num(axis.points)}`);
  }
  if (!bd.axes && (bd.objective || bd.analytical)) {
    line("Objective", num(bd.objective?.total));
    line("Analytical", num(bd.analytical?.total));
  }
  const notes: string[] = [];
  if (bd.confidence) notes.push(`confidence ${bd.confidence}`);
  if (bd.trace_quality) notes.push(`trace ${bd.trace_quality}`);
  if (bd.late_penalty) notes.push(chalk.yellow(`late penalty -${num(bd.late_penalty)}`));
  if (bd.baseline_lift && typeof bd.baseline_lift.delta === "number") {
    notes.push(bd.baseline_lift.beat ? chalk.green(`beat the solo-AI baseline by ${num(bd.baseline_lift.delta)}`) : "didn't beat the solo-AI baseline");
  }
  if (notes.length) display.info(`  ${notes.join(" · ")}`);
  if (bd.leaderboard_eligible === false && bd.ineligible_reason) display.warning(INELIGIBLE[bd.ineligible_reason] || "not on the leaderboard for this run");

  const moments = s.moments ?? [];
  if (moments.length) {
    heading("Moments");
    for (const m of moments) {
      const glyph = m.kind === "brilliant" || m.kind === "good" ? chalk.green(m.glyph.padEnd(2)) : chalk.yellow(m.glyph.padEnd(2));
      console.log(`  ${glyph} ${chalk.bold(m.label)}${m.axis ? chalk.dim(`  (${AXIS_LABELS[m.axis] || m.axis})`) : ""}`);
      if (m.detail) console.log(chalk.dim(`     ${m.detail}`));
    }
  }

  const c = s.celebration;
  if (c) {
    const wins: string[] = [];
    if (c.first_run) wins.push("first run");
    if (c.personal_best) wins.push("personal best");
    if (c.tier_up) wins.push(`tier up: ${c.tier_up.name || c.tier_up.to}`);
    for (const b of c.new_badges ?? []) wins.push(`badge: ${b.name}`);
    if (c.streak_milestone) wins.push(`${c.streak_milestone}-day streak`);
    if (wins.length) {
      heading("Unlocked");
      console.log(`  ${wins.join(" · ")}`);
    }
  }

  if (opts.verbose) {
    for (const axis of bd.axes ?? []) {
      heading(`${AXIS_LABELS[axis.name] || axis.name} signals`);
      const signals = axis.signals ?? [];
      const shares = weightShares(signals.map((s) => s.weight));
      const width = Math.max(22, ...signals.map((s) => s.name.length));
      signals.forEach((sig, i) => {
        const val = sig.skipped || sig.value === null ? chalk.dim("skipped") : `${int(sig.value * 100)}%`;
        console.log(`  ${sig.name.padEnd(width)} ${val.padStart(7)}  ${chalk.dim(`${int(shares[i])}% of ${AXIS_LABELS[axis.name] || axis.name}`)}`);
        if (sig.reason) console.log(`     ${sig.reason}`);
        for (const ev of (sig.evidence ?? []).slice(0, 2)) console.log(chalk.dim(`     > ${ev.slice(0, 160)}`));
      });
    }
  } else if (bd.axes?.length) {
    blank();
    display.info(`  Every signal with the judge's evidence: kodwai result ${s.id} --verbose`);
  }
  blank();
  display.info(`  ${url}`);
  display.info(`  Share it: kodwai share ${s.id}    Rate the challenge: kodwai rate ${s.id} --overall 1-5`);
  blank();
}

/** kodwai share [id]: a public link to a scored run's card. */
export async function share(id: string | undefined, opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  const sid = await resolveSubmissionId(ctx, id);
  let r: { share_token: string; share_url: string };
  try {
    r = await send(ctx, "POST", `/api/submissions/${encodeURIComponent(sid)}/share`, {});
  } catch (e) {
    if (e instanceof ApiError && (e.status === 400 || e.status === 409)) throw new Error("Only scored runs can be shared. Check it with: kodwai result " + sid);
    throw e;
  }
  if (ctx.json) return printJson(r);
  console.log("");
  display.success(`Share link: ${r.share_url}`);
  const text = encodeURIComponent("My kodwai run:");
  display.info(`  Post on X: https://x.com/intent/post?text=${text}&url=${encodeURIComponent(r.share_url)}`);
  display.info(`  LinkedIn:  https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(r.share_url)}`);
  console.log("");
}

export interface RateOptions extends CtxOptions {
  overall?: string;
  difficulty?: string;
  clarity?: string;
  comment?: string;
}

/** kodwai rate <id> --overall 1-5: rate the challenge a run was for. */
export async function rate(id: string | undefined, opts: RateOptions): Promise<void> {
  if (opts.overall === undefined) throw new Error("Give an overall rating: kodwai rate <id> --overall 1-5 [--difficulty 1-5] [--clarity 1-5] [--comment \"...\"]");
  const body: Record<string, unknown> = { rating_overall: intFlag("--overall", opts.overall, 0, 1, 5) };
  if (opts.difficulty !== undefined) body.rating_difficulty = intFlag("--difficulty", opts.difficulty, 0, 1, 5);
  if (opts.clarity !== undefined) body.rating_clarity = intFlag("--clarity", opts.clarity, 0, 1, 5);
  if (opts.comment !== undefined) {
    if (opts.comment.length > 2000) throw new Error("--comment is limited to 2000 characters.");
    body.comment = opts.comment;
  }
  const ctx = await authedCtx(opts);
  const s = await fetchSubmission(ctx, await resolveSubmissionId(ctx, id));
  body.submission_id = s.id;
  const saved = await send(ctx, "PUT", `/api/challenges/${s.challenge_id}/feedback`, body);
  if (ctx.json) return printJson(saved);
  display.success(`Rated ${s.challenge_title || s.challenge_slug}: ${body.rating_overall}/5. Thanks, it goes straight to the challenge authors.\n`);
}

/** kodwai delete <id>: delete a finished run, or stop one in progress. */
export async function deleteRun(id: string | undefined, opts: CtxOptions & { yes?: boolean }): Promise<void> {
  if (!id) throw new Error("Which run? kodwai delete <id>   (ids: kodwai submissions)");
  const ctx = await authedCtx(opts);
  const s = await fetchSubmission(ctx, id);
  if (!opts.yes) {
    if (!isInteractive()) throw new Error("Run `kodwai delete <id> --yes` to confirm without a terminal prompt.");
    const what = s.status === "in_progress" ? "stop this run in progress" : `delete this run (${num(s.score)})`;
    if (!(await confirm(`  ${s.challenge_title || s.challenge_slug}: ${what}? It can't be undone, and the free run isn't refunded. (y/N) `))) {
      display.info("  Kept it.");
      return;
    }
  }
  try {
    await send(ctx, "DELETE", `/api/submissions/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new Error("It's being scored right now. Try again when scoring finishes.");
    throw e;
  }
  if (ctx.json) return printJson({ deleted: id });
  display.success(`Deleted ${s.challenge_title || s.challenge_slug} (${id}).\n`);
}
