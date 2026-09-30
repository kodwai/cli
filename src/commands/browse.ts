import chalk from "chalk";
import { ApiError } from "../utils/api.js";
import { publicCtx, authedCtx, get, maybe, whenSignedIn, query, intFlag, oneOf, type CtxOptions, type Ctx } from "../utils/context.js";
import { table, num, int, countdown, nextUtcMidnight, day, heading, line, blank, printJson, AXIS_LABELS, you, minutes, weightShares } from "../utils/format.js";
import { display } from "../utils/display.js";

const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const SORTS = ["newest", "popular", "difficulty"] as const;

export interface ChallengeListItem {
  id: string;
  title: string;
  slug: string;
  description?: string;
  difficulty: string;
  category: string;
  tags?: string[];
  time_limit_minutes: number;
  is_featured?: boolean;
  submission_count: number;
  avg_score: number | null;
}

interface MySubmission {
  id: string;
  challenge_id: string;
  status: string;
  score: number | null;
}

/** Best score / state per challenge from the user's recent runs (up to 100). */
async function myMarks(ctx: Ctx): Promise<Map<string, { best: number | null; state: string }>> {
  const marks = new Map<string, { best: number | null; state: string }>();
  const subs = await whenSignedIn(ctx, () => get<MySubmission[]>(ctx, `/api/submissions/me${query({ limit: 100 })}`));
  for (const s of subs ?? []) {
    const cur = marks.get(s.challenge_id) ?? { best: null, state: "attempted" };
    if (s.status === "scored" && typeof s.score === "number") {
      cur.state = "solved";
      cur.best = Math.max(cur.best ?? 0, s.score);
    } else if (s.status === "in_progress" && cur.state !== "solved") {
      cur.state = "in progress";
    }
    marks.set(s.challenge_id, cur);
  }
  return marks;
}

function markText(mark?: { best: number | null; state: string }): string {
  if (!mark) return "";
  if (mark.state === "solved") return chalk.green(`✓ ${num(mark.best)}`);
  return chalk.yellow(mark.state);
}

export interface ChallengesOptions extends CtxOptions {
  search?: string;
  difficulty?: string;
  category?: string;
  sort?: string;
  limit?: string;
  page?: string;
}

/** kodwai challenges: the catalog, with your best score on the ones you've solved. */
export async function listChallenges(opts: ChallengesOptions): Promise<void> {
  const ctx = await publicCtx(opts);
  const params = {
    search: opts.search,
    difficulty: oneOf("--difficulty", opts.difficulty, DIFFICULTIES),
    category: opts.category,
    sort: oneOf("--sort", opts.sort, SORTS),
    limit: intFlag("--limit", opts.limit, 50),
    page: intFlag("--page", opts.page, 1, 1, 1000),
  };
  const items = await get<ChallengeListItem[]>(ctx, `/api/challenges${query(params)}`);
  const marks = await myMarks(ctx);
  if (ctx.json) {
    return printJson(items.map((c) => ({ ...c, my_best_score: marks.get(c.id)?.best ?? null, my_state: marks.get(c.id)?.state ?? null })));
  }
  if (items.length === 0) {
    display.info("\n  No challenges match. Try without filters: kodwai challenges\n");
    return;
  }
  heading(`Challenges${params.page > 1 ? ` (page ${params.page})` : ""}`);
  blank();
  console.log(
    table(items, [
      { header: "SLUG", value: (c) => c.slug },
      { header: "LEVEL", value: (c) => c.difficulty },
      { header: "CATEGORY", value: (c) => c.category, max: 18 },
      { header: "TIME", value: (c) => `${c.time_limit_minutes}m`, align: "right" },
      { header: "RUNS", value: (c) => int(c.submission_count), align: "right" },
      { header: "AVG", value: (c) => num(c.avg_score), align: "right" },
      ...(ctx.token ? [{ header: "YOU", value: (c: ChallengeListItem) => markText(marks.get(c.id)) }] : []),
    ]),
  );
  blank();
  display.info("  Details: kodwai info <slug>    Start: kodwai challenge <slug>");
  if (items.length === params.limit) display.info(`  More: kodwai challenges --page ${params.page + 1}`);
  blank();
}

/** kodwai challenges categories */
export async function listCategories(opts: CtxOptions): Promise<void> {
  const ctx = await publicCtx(opts);
  const cats = await get<{ category: string; count: number }[]>(ctx, "/api/challenges/categories");
  if (ctx.json) return printJson(cats);
  heading("Categories");
  blank();
  console.log(table(cats, [
    { header: "CATEGORY", value: (c) => c.category },
    { header: "CHALLENGES", value: (c) => int(c.count), align: "right" },
  ]));
  blank();
  display.info("  Filter: kodwai challenges --category <name>");
  blank();
}

interface Rubric {
  profile?: string;
  axes: { name: string; label?: string; blurb?: string; points: number; signals: { name: string; label?: string; description?: string; weight: number }[] }[];
}

interface BoardEntry {
  rank: number;
  user_id?: string;
  id?: string;
  name?: string | null;
  username?: string | null;
  score: number;
  agent_used?: string | null;
  model_display?: string | null;
  time_taken_ms?: number | null;
}

/** kodwai info <slug>: the spec sheet, how it's scored, your runs and the top 10. */
export async function challengeInfo(slug: string, opts: CtxOptions & { verbose?: boolean }): Promise<void> {
  const ctx = await publicCtx(opts);
  let detail: ChallengeListItem;
  try {
    detail = await get<ChallengeListItem>(ctx, `/api/challenges/${encodeURIComponent(slug)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`No challenge called "${slug}". List them with: kodwai challenges`);
    throw e;
  }
  const [rubric, board, mine, rating, me] = await Promise.all([
    maybe(get<Rubric>(ctx, `/api/challenges/${encodeURIComponent(slug)}/rubric`)),
    maybe(get<{ entries: BoardEntry[]; total: number }>(ctx, `/api/leaderboard/challenges/${detail.id}${query({ limit: 10 })}`)),
    whenSignedIn(ctx, () => get<(MySubmission & { created_at?: string; agent_used?: string })[]>(ctx, `/api/submissions/me${query({ challenge_id: detail.id, limit: 20 })}`)),
    whenSignedIn(ctx, () => get<{ avg_overall: number | null; avg_difficulty: number | null; avg_clarity: number | null; total_count: number }>(ctx, `/api/challenges/${detail.id}/feedback/summary`)),
    whenSignedIn(ctx, () => get<{ id: string }>(ctx, "/api/auth/me")),
  ]);
  if (ctx.json) {
    return printJson({ challenge: detail, rubric, leaderboard: board, viewer: me ? { user_id: me.id } : null, my_submissions: mine, ratings: rating });
  }

  heading(detail.title);
  blank();
  line("Slug", detail.slug);
  line("Level", `${detail.difficulty} · ${detail.category}${detail.tags?.length ? ` · ${detail.tags.join(", ")}` : ""}`);
  line("Time limit", `${detail.time_limit_minutes} min`);
  line("Runs", `${int(detail.submission_count)} scored · avg ${num(detail.avg_score)}`);
  if (rating && rating.total_count > 0) line("Rated", `${num(rating.avg_overall)}/5 by ${rating.total_count} (difficulty ${num(rating.avg_difficulty)}, clarity ${num(rating.avg_clarity)})`);
  if (detail.description) {
    blank();
    for (const l of detail.description.trim().split("\n")) console.log(`  ${l}`);
  }

  if (rubric?.axes?.length) {
    heading("How it's scored");
    for (const axis of rubric.axes) {
      console.log(`  ${chalk.bold((axis.label || AXIS_LABELS[axis.name] || axis.name).padEnd(18))} ${int(axis.points)} pts${axis.blurb ? chalk.dim(`  ${axis.blurb}`) : ""}`);
      if (opts.verbose) {
        const shares = weightShares(axis.signals.map((s) => s.weight));
        axis.signals.forEach((s, i) => {
          console.log(`    ${(s.label || s.name).padEnd(28)} ${int(shares[i]).padStart(3)}%${s.description ? chalk.dim(`  ${s.description}`) : ""}`);
        });
      }
    }
    if (!opts.verbose) display.info("  Signals and weights: kodwai info " + detail.slug + " --verbose");
  }

  if (mine && mine.length) {
    heading("Your runs");
    const best = Math.max(...mine.filter((s) => typeof s.score === "number").map((s) => s.score as number), -1);
    for (const s of mine.slice(0, 5)) {
      console.log(`  ${day(s.created_at)}  ${s.status.padEnd(11)} ${num(s.score).padStart(5)}${s.score === best ? chalk.green("  best") : ""}  ${chalk.dim(s.id)}`);
    }
  }

  heading("Top 10");
  if (!board || board.entries.length === 0) {
    display.info("  Nobody on the board yet. Be the first.");
  } else {
    console.log(
      table(board.entries, [
        { header: "#", value: (e) => int(e.rank), align: "right" },
        { header: "DEVELOPER", value: (e) => (e.username ? `@${e.username}` : e.name || "anon") + you(!!me && e.user_id === me.id), max: 30 },
        { header: "AGENT", value: (e) => e.agent_used || "–" },
        { header: "MODEL", value: (e) => e.model_display || "–", max: 20 },
        { header: "TIME", value: (e) => minutes(e.time_taken_ms), align: "right" },
        { header: "SCORE", value: (e) => num(e.score), align: "right" },
      ]),
    );
  }
  blank();
  display.info(`  Start: kodwai challenge ${detail.slug}`);
  blank();
}

/** kodwai daily: the Challenge of the Day and whether you've cleared it. */
export async function daily(opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  const d = await get<{ challenge: ChallengeListItem; completed_today: boolean; date: string }>(ctx, "/api/challenges/daily");
  if (ctx.json) return printJson({ ...d, resets_at: nextUtcMidnight() });
  const c = d.challenge;
  heading(`Challenge of the Day · ${d.date}`);
  blank();
  line("Challenge", `${c.title} (${c.slug})`);
  line("Level", `${c.difficulty} · ${c.category} · ${c.time_limit_minutes} min`);
  line("Runs", `${int(c.submission_count)} · avg ${num(c.avg_score)}`);
  line("You", d.completed_today ? chalk.green("cleared today ✓") : "not cleared yet");
  line("Resets in", countdown(nextUtcMidnight()));
  blank();
  if (!d.completed_today) display.info(`  Start: kodwai challenge ${c.slug}`);
  blank();
}

/** kodwai sprint: this week's sprint challenge and live standings. */
export async function sprint(opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  let s: {
    week_key: string;
    ends_at: string;
    challenge: ChallengeListItem;
    leaderboard: BoardEntry[];
    me: { rank: number | null; best_score: number | null; participated: boolean };
  };
  try {
    s = await get(ctx, "/api/sprint/current");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      if (ctx.json) return printJson(null);
      display.info("\n  The weekly sprint is switched off right now.\n");
      return;
    }
    throw e;
  }
  if (ctx.json) return printJson(s);
  heading(`Weekly sprint · ${s.week_key}`);
  blank();
  line("Challenge", `${s.challenge.title} (${s.challenge.slug})`);
  line("Level", `${s.challenge.difficulty} · ${s.challenge.category} · ${s.challenge.time_limit_minutes} min`);
  line("Closes in", countdown(s.ends_at));
  line("You", s.me.participated ? `#${int(s.me.rank)} · best ${num(s.me.best_score)}` : "not in yet");
  printSmallBoard(s.leaderboard.slice(0, 15), s.me.rank);
  if (!s.me.participated) display.info(`  Start: kodwai challenge ${s.challenge.slug}`);
  blank();
}

function printSmallBoard(entries: BoardEntry[], myRank?: number | null): void {
  heading("Standings");
  if (entries.length === 0) {
    display.info("  Nobody yet.");
    return;
  }
  console.log(
    table(entries, [
      { header: "#", value: (e) => int(e.rank), align: "right" },
      { header: "DEVELOPER", value: (e) => (e.username ? `@${e.username}` : e.name || "anon") + you(myRank != null && e.rank === myRank), max: 30 },
      { header: "AGENT", value: (e) => e.agent_used || "–" },
      { header: "SCORE", value: (e) => num(e.score), align: "right" },
    ]),
  );
  blank();
}

interface EventItem {
  id: string;
  title: string;
  slug: string;
  description?: string | null;
  starts_at: string;
  ends_at: string;
  status: "upcoming" | "active" | "ended";
  is_finalized: boolean;
}

/** kodwai events [slug]: all events, or one event and its board. */
export async function events(slug: string | undefined, opts: CtxOptions): Promise<void> {
  const ctx = await publicCtx(opts);
  if (!slug) {
    const list = await get<EventItem[]>(ctx, "/api/events");
    const order = { active: 0, upcoming: 1, ended: 2 } as const;
    list.sort((a, b) => order[a.status] - order[b.status]);
    if (ctx.json) return printJson(list);
    heading("Events");
    if (list.length === 0) {
      display.info("  No events yet.\n");
      return;
    }
    blank();
    console.log(
      table(list, [
        { header: "STATUS", value: (e) => (e.status === "active" ? chalk.green("live") : e.status) },
        { header: "SLUG", value: (e) => e.slug },
        { header: "TITLE", value: (e) => e.title, max: 36 },
        {
          header: "WHEN",
          value: (e) => (e.status === "active" ? `closes in ${countdown(e.ends_at)}` : e.status === "upcoming" ? `opens in ${countdown(e.starts_at)}` : `ended ${day(e.ends_at)}`),
        },
      ]),
    );
    blank();
    display.info("  Board: kodwai events <slug>");
    blank();
    return;
  }
  let ev: EventItem;
  try {
    ev = await get<EventItem>(ctx, `/api/events/${encodeURIComponent(slug)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`No event called "${slug}". List them with: kodwai events`);
    throw e;
  }
  const board = await get<BoardEntry[]>(ctx, `/api/events/${encodeURIComponent(slug)}/leaderboard`);
  if (ctx.json) return printJson({ event: ev, leaderboard: board });
  heading(ev.title);
  blank();
  line("Status", ev.status === "active" ? chalk.green("live") : ev.status + (ev.is_finalized ? " · final results" : ""));
  line("Window", `${day(ev.starts_at)} → ${day(ev.ends_at)}`);
  if (ev.status === "active") line("Closes in", countdown(ev.ends_at));
  if (ev.status === "upcoming") line("Opens in", countdown(ev.starts_at));
  if (ev.description) {
    blank();
    for (const l of ev.description.trim().split("\n")) console.log(`  ${l}`);
  }
  printSmallBoard(board.slice(0, 25));
}
