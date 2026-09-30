import chalk from "chalk";
import { ApiError } from "../utils/api.js";
import { publicCtx, authedCtx, get, whenSignedIn, query, intFlag, oneOf, type CtxOptions } from "../utils/context.js";
import { table, num, int, countdown, heading, line, blank, printJson, you, minutes, AGENTS } from "../utils/format.js";
import { display } from "../utils/display.js";

interface Tier {
  key: string;
  name: string;
  next_name?: string | null;
  next_at?: number | null;
  progress?: number | null;
}

interface GlobalEntry {
  id: string;
  name?: string | null;
  username?: string | null;
  preferred_agent?: string | null;
  streak_days?: number | null;
  direction_rating?: number | null;
  total_score: number;
  challenges_completed: number;
  rank: number;
  tier?: Tier | null;
}

export interface LeaderboardOptions extends CtxOptions {
  agent?: string;
  model?: string;
  category?: string;
  limit?: string;
  page?: string;
}

/** kodwai leaderboard [challenge-slug]: the all-time board (or one challenge's), with your rank. */
export async function leaderboard(target: string | undefined, opts: LeaderboardOptions): Promise<void> {
  if (target === "filters") return leaderboardFilters(opts);
  if (target === "me") return myChallengeRanks(opts);
  if (target) return challengeBoard(target, opts);

  const ctx = await publicCtx(opts);
  const filters = {
    agent: oneOf("--agent", opts.agent, AGENTS),
    model: opts.model,
    category: opts.category,
  };
  const page = intFlag("--page", opts.page, 1, 1, 1000);
  const limit = intFlag("--limit", opts.limit, 25);
  const [board, mine, viewer] = await Promise.all([
    get<{ entries: GlobalEntry[]; total: number; page: number; limit: number }>(ctx, `/api/leaderboard${query({ ...filters, page, limit })}`),
    whenSignedIn(ctx, () => get<{ entry: GlobalEntry | null }>(ctx, `/api/leaderboard/me/rank${query(filters)}`)),
    whenSignedIn(ctx, () => get<{ username?: string | null }>(ctx, "/api/auth/me")),
  ]);
  if (ctx.json) {
    // Say who "you" is outright: a null `me` is easy to misread as "the top row".
    return printJson({ ...board, viewer: viewer ? { username: viewer.username ?? null, ranked: !!mine?.entry } : null, me: mine?.entry ?? null });
  }

  const scope = [filters.agent, filters.model, filters.category].filter(Boolean).join(" · ");
  heading(`Leaderboard${scope ? ` · ${scope}` : ""}`);
  display.info(`  ${int(board.total)} developer${board.total === 1 ? "" : "s"} ranked. Page ${board.page}.`);
  blank();
  const me = mine?.entry ?? null;
  const rows = [...board.entries];
  const onPage = me && rows.some((r) => r.id === me.id);
  console.log(
    table(rows, [
      { header: "#", value: (e) => int(e.rank), align: "right" },
      { header: "DEVELOPER", value: (e) => (e.username ? `@${e.username}` : e.name || "anon") + you(!!me && e.id === me.id), max: 30 },
      { header: "TIER", value: (e) => e.tier?.name || "–" },
      { header: "ELO", value: (e) => int(e.direction_rating), align: "right" },
      { header: "AGENT", value: (e) => e.preferred_agent || "–" },
      { header: "SOLVED", value: (e) => int(e.challenges_completed), align: "right" },
      { header: "SCORE", value: (e) => num(e.total_score), align: "right" },
    ]),
  );
  blank();
  if (me && !onPage) {
    line("You", `#${int(me.rank)} · ${me.tier?.name || "–"} · Elo ${int(me.direction_rating)} · ${int(me.challenges_completed)} solved · ${num(me.total_score)}`);
    blank();
  } else if (!me && ctx.token) {
    display.info("  You're not on this board yet. A scored run puts you on it: kodwai challenges");
    blank();
  }
  if (board.page * board.limit < board.total) display.info(`  More: kodwai leaderboard --page ${board.page + 1}`);
  display.info("  Filters: --agent claude-code|cursor|codex  --model <slug>  --category <name>   (values: kodwai leaderboard filters)");
  blank();
}

interface ChallengeEntry {
  rank: number;
  user_id: string;
  name?: string | null;
  username?: string | null;
  score: number;
  agent_used?: string | null;
  model_display?: string | null;
  time_taken_ms?: number | null;
}

async function challengeBoard(slug: string, opts: LeaderboardOptions): Promise<void> {
  const ctx = await publicCtx(opts);
  let challenge: { id: string; title: string; slug: string };
  try {
    challenge = await get(ctx, `/api/challenges/${encodeURIComponent(slug)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`No challenge called "${slug}". List them with: kodwai challenges`);
    throw e;
  }
  const page = intFlag("--page", opts.page, 1, 1, 1000);
  const limit = intFlag("--limit", opts.limit, 25);
  const filters = { agent: oneOf("--agent", opts.agent, AGENTS), model: opts.model };
  const [board, me] = await Promise.all([
    get<{ entries: ChallengeEntry[]; total: number; page: number; limit: number }>(ctx, `/api/leaderboard/challenges/${challenge.id}${query({ ...filters, page, limit })}`),
    whenSignedIn(ctx, () => get<{ id: string }>(ctx, "/api/auth/me")),
  ]);
  if (ctx.json) {
    const mine = me ? board.entries.find((e) => e.user_id === me.id) ?? null : null;
    return printJson({ challenge, ...board, viewer: me ? { user_id: me.id, on_this_page: !!mine } : null, me: mine });
  }
  heading(`${challenge.title} · leaderboard`);
  display.info(`  ${int(board.total)} developer${board.total === 1 ? "" : "s"} ranked. Page ${board.page}.`);
  blank();
  if (board.entries.length === 0) {
    display.info("  Nobody on this board yet.\n");
    return;
  }
  console.log(
    table(board.entries, [
      { header: "#", value: (e) => int(e.rank), align: "right" },
      { header: "DEVELOPER", value: (e) => (e.username ? `@${e.username}` : e.name || "anon") + you(!!me && e.user_id === me.id), max: 30 },
      { header: "AGENT", value: (e) => e.agent_used || "–" },
      { header: "MODEL", value: (e) => e.model_display || "–", max: 22 },
      { header: "TIME", value: (e) => minutes(e.time_taken_ms), align: "right" },
      { header: "SCORE", value: (e) => num(e.score), align: "right" },
    ]),
  );
  blank();
  if (board.page * board.limit < board.total) display.info(`  More: kodwai leaderboard ${challenge.slug} --page ${board.page + 1}`);
  blank();
}

async function leaderboardFilters(opts: CtxOptions): Promise<void> {
  const ctx = await publicCtx(opts);
  const [models, categories] = await Promise.all([
    get<{ slug: string; display: string }[]>(ctx, "/api/leaderboard/models"),
    get<{ category: string; developer_count: number; challenge_count: number }[]>(ctx, "/api/leaderboard/categories"),
  ]);
  if (ctx.json) return printJson({ agents: AGENTS, models, categories });
  heading("Leaderboard filters");
  blank();
  line("--agent", AGENTS.join(", "));
  blank();
  if (models.length) {
    console.log(table(models, [
      { header: "--model", value: (m) => m.slug },
      { header: "NAME", value: (m) => m.display },
    ]));
  } else {
    line("--model", chalk.dim("no ranked models yet"));
  }
  blank();
  console.log(table(categories, [
    { header: "--category", value: (c) => c.category },
    { header: "DEVELOPERS", value: (c) => int(c.developer_count), align: "right" },
    { header: "CHALLENGES", value: (c) => int(c.challenge_count), align: "right" },
  ]));
  blank();
}

/** kodwai leaderboard me: your best score on every challenge you've been ranked on. */
async function myChallengeRanks(opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  const rows = await get<{ challenge_title: string; challenge_slug: string; difficulty: string; score: number; agent_used?: string; model_display?: string }[]>(ctx, "/api/leaderboard/me");
  if (ctx.json) return printJson(rows);
  heading("Your ranked challenges");
  if (rows.length === 0) {
    display.info("  None yet. Scored runs with a leaderboard-eligible key show up here.\n");
    return;
  }
  blank();
  console.log(table(rows, [
    { header: "CHALLENGE", value: (r) => r.challenge_slug },
    { header: "LEVEL", value: (r) => r.difficulty },
    { header: "AGENT", value: (r) => r.agent_used || "–" },
    { header: "MODEL", value: (r) => r.model_display || "–", max: 20 },
    { header: "BEST", value: (r) => num(r.score), align: "right" },
  ]));
  blank();
  display.info("  Where you stand on one: kodwai leaderboard <slug>");
  blank();
}

interface LeagueMe {
  week: string;
  ends_at: string;
  division: { key: string; name: string; order: number };
  joined: boolean;
  size: number;
  promote_count: number;
  demote_count: number;
  my_rank: number | null;
  my_points: number | null;
  members: { rank: number; username?: string | null; name?: string | null; tier_key?: string | null; points: number; runs: number; is_me: boolean; zone: "promotion" | "safe" | "demotion" }[];
  last_week: { week: string; division: string; rank: number; size: number; outcome: "promoted" | "demoted" | "stayed" } | null;
}

const DIVISIONS = ["bronze", "silver", "gold", "platinum", "diamond", "master"];

/** kodwai league: your weekly division, your spot, and the zones. */
export async function league(opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  const lg = await get<LeagueMe>(ctx, "/api/leagues/me");
  if (ctx.json) return printJson(lg);
  const weekNo = lg.week.split("-W")[1] ?? lg.week;
  heading(`Week ${weekNo} · ${lg.division.name} league`);
  blank();
  line("Ladder", DIVISIONS.map((d) => (d === lg.division.key ? chalk.bold(`[${d}]`) : chalk.dim(d))).join(" "));
  line("Resets in", countdown(lg.ends_at));
  if (lg.last_week) {
    const verb = lg.last_week.outcome === "promoted" ? chalk.green("promoted") : lg.last_week.outcome === "demoted" ? chalk.red("dropped") : "held";
    line("Last week", `#${lg.last_week.rank} of ${lg.last_week.size} in ${lg.last_week.division}, ${verb}`);
  }
  if (!lg.joined) {
    blank();
    display.info("  Not placed yet this week. Your first scored run puts you in a league.");
    blank();
    return;
  }
  line("You", `#${int(lg.my_rank)} of ${lg.size} · ${num(lg.my_points)} pts`);
  const zonesOpen = lg.size >= 10;
  line("Zones", zonesOpen ? `top ${lg.promote_count} go up, bottom ${lg.demote_count} go down` : "open at 10 players");
  blank();
  const zone = (z: string) => (z === "promotion" ? chalk.green("▲") : z === "demotion" ? chalk.red("▼") : " ");
  console.log(
    table(lg.members, [
      { header: " ", value: (m) => (zonesOpen ? zone(m.zone) : " ") },
      { header: "#", value: (m) => int(m.rank), align: "right" },
      { header: "DEVELOPER", value: (m) => (m.username ? `@${m.username}` : m.name || "anon") + you(m.is_me), max: 30 },
      { header: "TIER", value: (m) => m.tier_key || "–" },
      { header: "RUNS", value: (m) => int(m.runs), align: "right" },
      { header: "POINTS", value: (m) => num(m.points), align: "right" },
    ]),
  );
  blank();
  display.info("  Points: your best score per challenge this week, x1 easy / x1.5 medium / x2 hard.");
  blank();
}

