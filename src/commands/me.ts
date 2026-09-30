import chalk from "chalk";
import { ApiError } from "../utils/api.js";
import { publicCtx, authedCtx, get, send, maybe, oneOf, type CtxOptions } from "../utils/context.js";
import { table, num, int, bar, countdown, nextUtcMidnight, day, heading, line, blank, printJson, minutes } from "../utils/format.js";
import { display } from "../utils/display.js";

interface Profile {
  name?: string | null;
  username?: string | null;
  bio?: string | null;
  github_url?: string | null;
  linkedin_url?: string | null;
  website_url?: string | null;
  x_url?: string | null;
  preferred_agent?: string | null;
  total_score?: number | null;
  challenges_completed?: number | null;
  rank?: number | null;
  streak_days?: number | null;
  direction_rating?: number | null;
  efficiency_rating?: number | null;
  ability_theta?: number | null;
  ability_se?: number | null;
  xp?: number | null;
  tier?: { name: string; next_name?: string | null; next_at?: number | null; progress?: number | null } | null;
  level?: { level: number; xp: number; next_level_xp: number; progress: number } | null;
  recent_submissions?: { id: string; score: number | null; agent_used?: string | null; model_display?: string | null; time_taken_ms?: number | null; scored_at?: string | null; challenge_slug?: string | null; difficulty?: string | null }[];
  badges?: Badge[];
}

interface Skills {
  category: { key: string; rating: number }[];
  model: { key: string; rating: number }[];
}

interface Badge {
  slug: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  category: string;
  earned_at?: string | null;
}

/** kodwai profile [username]: your player card (or anyone's public one). */
export async function profile(username: string | undefined, opts: CtxOptions): Promise<void> {
  const own = !username;
  const ctx = own ? await authedCtx(opts) : await publicCtx(opts);
  const handle = username?.replace(/^@/, "");
  let p: Profile;
  try {
    p = await get<Profile>(ctx, own ? "/api/developers/me" : `/api/developers/${encodeURIComponent(handle!)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`No developer called "${handle}".`);
    if (e instanceof ApiError && e.status === 403 && own) throw new Error("Profiles are for developer accounts. This account is a company account.");
    throw e;
  }
  const [skills, badges] = await Promise.all([
    maybe(get<Skills>(ctx, own ? "/api/developers/me/skills" : `/api/developers/${encodeURIComponent(handle!)}/skills`)),
    own ? maybe(get<Badge[]>(ctx, "/api/badges/me")) : Promise.resolve(p.badges ?? []),
  ]);
  if (ctx.json) return printJson({ profile: p, skills, badges });

  heading(`${p.name || p.username || "Developer"}${p.username ? chalk.dim(`  @${p.username}`) : ""}`);
  if (p.bio) display.info(`  ${p.bio}`);
  blank();
  const tier = p.tier;
  line("Tier", tier ? `${tier.name}${tier.next_name ? chalk.dim(`  ${bar(tier.progress ?? 0, 12)} next: ${tier.next_name} at ${int(tier.next_at)}`) : ""}` : "–");
  line("Direction Elo", int(p.direction_rating));
  if (p.level) line("Level", `${p.level.level} · ${int(p.level.xp)} XP ${chalk.dim(`${bar(p.level.progress, 12)} next at ${int(p.level.next_level_xp)}`)}`);
  line("Rank", p.rank ? `#${int(p.rank)} all-time` : "unranked");
  line("Solved", `${int(p.challenges_completed)} · total score ${num(p.total_score)}`);
  line("Streak", `${int(p.streak_days)} day${p.streak_days === 1 ? "" : "s"}`);
  line("Efficiency", int(p.efficiency_rating));
  if (typeof p.ability_theta === "number") {
    const se = p.ability_se ?? 0;
    line("Ability θ", `${num(p.ability_theta, 2)} ± ${num(se, 2)} ${chalk.dim(`(95%: ${num(p.ability_theta - 1.96 * se, 2)} to ${num(p.ability_theta + 1.96 * se, 2)})`)}`);
  }
  line("Agent", p.preferred_agent || "–");
  const links = [p.github_url, p.x_url, p.linkedin_url, p.website_url].filter(Boolean);
  if (links.length) line("Links", links.join("  "));

  if (skills && (skills.category.length || skills.model.length)) {
    heading("Mastery");
    for (const c of skills.category.slice(0, 8)) {
      console.log(`  ${c.key.padEnd(22)} ${bar((c.rating - 900) / 800, 16)} ${int(c.rating)}`);
    }
    if (skills.model.length) {
      display.info(`  Models: ${skills.model.slice(0, 5).map((m) => `${m.key} ${int(m.rating)}`).join(" · ")}`);
    }
  }

  if (badges && badges.length) {
    heading(`Badges (${badges.length})`);
    console.log("  " + badges.map((b) => b.name).join(" · "));
  }

  const recent = p.recent_submissions ?? [];
  if (recent.length) {
    heading("Recent runs");
    console.log(
      table(recent.slice(0, 8), [
        { header: "DATE", value: (r) => day(r.scored_at) },
        { header: "CHALLENGE", value: (r) => r.challenge_slug || "–" },
        { header: "AGENT", value: (r) => r.agent_used || "–" },
        { header: "TIME", value: (r) => minutes(r.time_taken_ms), align: "right" },
        { header: "SCORE", value: (r) => num(r.score), align: "right" },
      ]),
    );
  }
  blank();
  if (p.username) display.info(`  Public profile: ${ctx.webUrl}/developers/${p.username}`);
  if (own) display.info("  Edit: kodwai profile edit --bio \"...\" --github <url> --x <url> --linkedin <url> --website <url>");
  blank();
}

export interface ProfileEdit {
  bio?: string;
  github?: string;
  x?: string;
  linkedin?: string;
  website?: string;
}

/** A bare "@handle" for X becomes https://x.com/handle, like the web settings page. */
export function normalizeX(v: string): string {
  const t = v.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  return `https://x.com/${t.replace(/^@/, "")}`;
}

/** kodwai profile edit --bio ... : update the public profile fields you pass. */
export async function editProfile(edit: ProfileEdit, opts: CtxOptions): Promise<void> {
  const body: Record<string, string> = {};
  if (edit.bio !== undefined) body.bio = edit.bio;
  if (edit.github !== undefined) body.github_url = edit.github;
  if (edit.linkedin !== undefined) body.linkedin_url = edit.linkedin;
  if (edit.website !== undefined) body.website_url = edit.website;
  if (edit.x !== undefined) body.x_url = normalizeX(edit.x);
  if (Object.keys(body).length === 0) {
    throw new Error('Nothing to change. Pass any of: --bio "..." --github <url> --x <@handle|url> --linkedin <url> --website <url>');
  }
  const ctx = await authedCtx(opts);
  const p = await send<Profile>(ctx, "PUT", "/api/developers/me", body);
  if (ctx.json) return printJson(p);
  display.success(`Profile updated: ${Object.keys(body).map((k) => k.replace(/_url$/, "")).join(", ")}`);
  if (p.username) display.info(`  ${ctx.webUrl}/developers/${p.username}\n`);
}

interface BadgeCatalog extends Badge {
  earned_count?: number;
  earned_percentage?: number;
}

interface BadgeProgress {
  slug: string;
  earned: boolean;
  progressable: boolean;
  current: number;
  target: number;
}

/** kodwai badges: what you hold, what's close, and how rare each is. */
export async function badges(opts: CtxOptions & { all?: boolean }): Promise<void> {
  const ctx = await authedCtx(opts);
  const [catalog, progress, mine] = await Promise.all([
    get<BadgeCatalog[]>(ctx, "/api/badges"),
    get<BadgeProgress[]>(ctx, "/api/badges/progress"),
    get<Badge[]>(ctx, "/api/badges/me"),
  ]);
  const prog = new Map(progress.map((p) => [p.slug, p]));
  const held = new Map(mine.map((b) => [b.slug, b]));
  const rows = catalog.map((b) => ({
    ...b,
    earned: held.has(b.slug),
    earned_at: held.get(b.slug)?.earned_at ?? null,
    current: prog.get(b.slug)?.current ?? null,
    target: prog.get(b.slug)?.target ?? null,
    progressable: prog.get(b.slug)?.progressable ?? false,
  }));
  if (ctx.json) return printJson(rows);

  const rarest = rows.filter((r) => r.earned && typeof r.earned_percentage === "number").sort((a, b) => a.earned_percentage! - b.earned_percentage!)[0];
  heading(`Badges · ${held.size} of ${catalog.length}`);
  if (rarest) display.info(`  Rarest you hold: ${rarest.name} (${num(rarest.earned_percentage)}% of developers)`);
  const groups = ["milestone", "streak", "skill", "special"];
  for (const g of [...groups, ...new Set(rows.map((r) => r.category).filter((c) => !groups.includes(c)))]) {
    const list = rows.filter((r) => r.category === g && (opts.all || r.earned || r.progressable));
    if (!list.length) continue;
    heading(g[0].toUpperCase() + g.slice(1));
    for (const b of list) {
      const status = b.earned
        ? chalk.green(`✓ since ${day(b.earned_at)}`)
        : b.progressable && b.target
          ? `${bar((b.current ?? 0) / b.target, 12)} ${int(b.current)}/${int(b.target)}`
          : chalk.dim("locked");
      const rarity = typeof b.earned_percentage === "number" ? chalk.dim(`  ${num(b.earned_percentage)}% have it`) : "";
      console.log(`  ${b.name}`.padEnd(26) + ` ${status}${rarity}`);
      if (b.description && !b.earned) console.log(chalk.dim(`      ${b.description}`));
    }
  }
  blank();
  if (!opts.all) display.info("  Every badge, including locked ones: kodwai badges --all");
  blank();
}

interface Quest {
  key: string;
  scope: "daily" | "weekly";
  title: string;
  description?: string;
  target: number;
  current: number;
  reward_xp: number;
  completed: boolean;
  claimed: boolean;
}

function nextMondayUtc(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const add = ((8 - d.getUTCDay()) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString();
}

/** kodwai quests: daily and weekly quests, progress and XP. */
export async function quests(opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  const list = await get<Quest[]>(ctx, "/api/quests");
  if (ctx.json) return printJson(list);
  const banked = list.filter((q) => q.claimed).reduce((s, q) => s + q.reward_xp, 0);
  const offered = list.reduce((s, q) => s + q.reward_xp, 0);
  heading(`Quests · ${banked} of ${offered} XP banked`);
  for (const scope of ["daily", "weekly"] as const) {
    const qs = list.filter((q) => q.scope === scope);
    if (!qs.length) continue;
    heading(`${scope === "daily" ? "Daily" : "Weekly"} ${chalk.dim(`resets in ${countdown(scope === "daily" ? nextUtcMidnight() : nextMondayUtc())}`)}`);
    for (const q of qs) {
      const state = q.claimed ? chalk.green("banked") : q.completed ? chalk.yellow(`claim: kodwai quests claim ${q.key}`) : `${bar(q.current / Math.max(1, q.target), 10)} ${q.current}/${q.target}`;
      console.log(`  ${q.title.padEnd(30)} +${q.reward_xp} XP  ${state}`);
      if (q.description && !q.claimed) console.log(chalk.dim(`      ${q.description}`));
    }
  }
  blank();
}

/** kodwai quests claim <key|all> */
export async function claimQuest(key: string | undefined, opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  const list = await get<Quest[]>(ctx, "/api/quests");
  const targets = key === "all" || !key ? list.filter((q) => q.completed && !q.claimed) : list.filter((q) => q.key === key);
  if (key && key !== "all" && targets.length === 0) throw new Error(`No quest "${key}". See them with: kodwai quests`);
  const results: { key: string; reward_xp?: number; error?: string }[] = [];
  for (const q of targets) {
    try {
      const r = await send<{ reward_xp: number }>(ctx, "POST", `/api/quests/${encodeURIComponent(q.key)}/claim`, {});
      results.push({ key: q.key, reward_xp: r.reward_xp });
    } catch (e) {
      results.push({ key: q.key, error: (e as Error).message });
    }
  }
  if (ctx.json) return printJson(results);
  if (results.length === 0) {
    display.info("\n  Nothing to claim right now. Progress: kodwai quests\n");
    return;
  }
  console.log("");
  for (const r of results) {
    if (r.error) display.warning(`${r.key}: ${r.error}`);
    else display.success(`${r.key}: +${r.reward_xp} XP`);
  }
  console.log("");
}

/** kodwai wrapped: your year (or all time) in numbers. */
export async function wrapped(opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  let w: Record<string, any>;
  try {
    w = await get(ctx, "/api/developers/me/wrapped");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      if (ctx.json) return printJson(null);
      display.info("\n  Wrapped is switched off right now.\n");
      return;
    }
    throw e;
  }
  if (ctx.json) return printJson(w);
  heading(`Your kodwai Wrapped${w.username ? chalk.dim(`  @${w.username}`) : ""}`);
  blank();
  line("Member since", day(w.member_since), 18);
  line("Runs scored", int(w.submissions), 18);
  line("Solved", int(w.challenges_completed), 18);
  line("Best run", num(w.best_score), 18);
  line("Direction Elo", `${int(w.direction_rating)} ${chalk.dim(`(${w.direction_rating >= 1000 ? "+" : ""}${int(w.direction_rating - 1000)} from 1000)`)}`, 18);
  line("Efficiency", int(w.efficiency_rating), 18);
  line("Streak", `${int(w.streak_days)} day${w.streak_days === 1 ? "" : "s"}`, 18);
  line("Rank", w.rank ? `#${int(w.rank)}` : "unranked", 18);
  line("Badges", int(w.badges_count), 18);
  line("Favorite agent", w.favorite_agent || "–", 18);
  line("Favorite model", w.favorite_model || "–", 18);
  if (w.top_category) line("Top category", `${w.top_category.key} (${int(w.top_category.rating)})`, 18);
  blank();
}

/** kodwai card: your live rank card for a GitHub README. */
export async function card(opts: CtxOptions & { theme?: string }): Promise<void> {
  const theme = oneOf("--theme", opts.theme, ["dark", "light", "signal"] as const) ?? "dark";
  const ctx = await authedCtx(opts);
  const me = await get<{ username?: string | null }>(ctx, "/api/auth/me");
  if (!me.username) throw new Error("Set a username first: kodwai username <name>");
  const svg = `${ctx.baseUrl}/api/developers/${me.username}/card.svg${theme === "dark" ? "" : `?theme=${theme}`}`;
  const profileUrl = `${ctx.webUrl}/developers/${me.username}`;
  const markdown = `[![kodwai rank card](${svg})](${profileUrl})`;
  if (ctx.json) return printJson({ svg_url: svg, profile_url: profileUrl, markdown, theme });
  heading(`Rank card · ${theme}`);
  blank();
  line("Image", svg);
  line("Profile", profileUrl);
  blank();
  display.info("  Paste into your GitHub README:");
  console.log(`  ${markdown}`);
  blank();
  display.info("  Themes: --theme dark|light|signal. The card updates itself (cached for an hour).");
  blank();
}
