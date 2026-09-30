import chalk from "chalk";
import { ApiError } from "../utils/api.js";
import { authedCtx, publicCtx, get, send, intFlag, type CtxOptions } from "../utils/context.js";
import { table, day, heading, line, blank, printJson } from "../utils/format.js";
import { display } from "../utils/display.js";
import { openBrowser } from "../utils/browser.js";
import { askSecret, confirm, isInteractive } from "../utils/prompt.js";

/** kodwai username <name>: set your public handle. */
export async function setUsername(name: string | undefined, opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  if (!name) {
    const me = await get<{ username?: string | null }>(ctx, "/api/auth/me");
    if (ctx.json) return printJson({ username: me.username ?? null });
    display.info(me.username ? `\n  You're @${me.username}. Change it: kodwai username <new-name>\n` : "\n  No username yet. Set one: kodwai username <name>\n");
    return;
  }
  const clean = name.replace(/^@/, "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,50}$/.test(clean)) throw new Error("Usernames are 3 to 50 characters: lowercase letters, digits, _ and -.");
  const user = await send<{ username: string }>(ctx, "PATCH", "/api/auth/me/username", { username: clean });
  if (ctx.json) return printJson(user);
  display.success(`You're now @${user.username}: ${ctx.webUrl}/developers/${user.username}\n`);
}

interface ApiKey {
  id: string;
  label: string;
  key_last4: string;
  is_active: boolean;
  created_at: string;
}

interface Me {
  has_claude_api_key?: boolean;
  free_submissions_used?: number;
  free_submissions_limit?: number;
  free_submissions_remaining?: number;
  can_submit?: boolean;
}

/** kodwai key: the scoring key on your account and your free runs. */
export async function keyStatus(opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  const [me, keys] = await Promise.all([get<Me>(ctx, "/api/auth/me"), get<ApiKey[]>(ctx, "/api/api-keys")]);
  if (ctx.json) return printJson({ keys, has_claude_api_key: me.has_claude_api_key, free_submissions_used: me.free_submissions_used, free_submissions_limit: me.free_submissions_limit, free_submissions_remaining: me.free_submissions_remaining, can_submit: me.can_submit });
  heading("Scoring key");
  blank();
  if (keys.length) {
    console.log(table(keys, [
      { header: "LABEL", value: (k) => k.label },
      { header: "KEY", value: (k) => `sk-ant-····${k.key_last4}` },
      { header: "ACTIVE", value: (k) => (k.is_active ? chalk.green("yes") : "no") },
      { header: "ADDED", value: (k) => day(k.created_at) },
      { header: "ID", value: (k) => chalk.dim(k.id) },
    ]));
    blank();
    display.info("  Your own key: unlimited runs, and your runs count on the leaderboard.");
  } else {
    line("Free runs", `${me.free_submissions_remaining ?? 0} of ${me.free_submissions_limit ?? 0} left`);
    display.info("  Add your Anthropic key for unlimited runs: kodwai key add");
  }
  blank();
}

/**
 * kodwai key add: connect an Anthropic key. The key is typed into a hidden
 * prompt in your terminal, never passed as an argument (shell history) or
 * through an agent's chat. With no terminal, the settings page opens instead.
 */
export async function keyAdd(opts: CtxOptions & { label?: string }): Promise<void> {
  const ctx = await authedCtx(opts);
  if (!isInteractive()) {
    const url = `${ctx.webUrl}/dev/settings`;
    openBrowser(url);
    if (ctx.json) return printJson({ opened: url });
    display.info(`\n  Opened ${url}`);
    display.info("  Paste your Anthropic key there (it's checked with Anthropic and stored encrypted).");
    display.info("  Or run `kodwai key add` in your own terminal. Never paste the key into a chat.\n");
    return;
  }
  display.info("\n  Your key is checked with Anthropic, stored encrypted, and only used to score your own runs.");
  const key = await askSecret("  Anthropic API key (sk-ant-..., hidden): ");
  if (!key) {
    display.info("  Nothing entered. No change.\n");
    return;
  }
  if (!key.startsWith("sk-ant-")) throw new Error("That doesn't look like an Anthropic key (they start with sk-ant-).");
  try {
    const saved = await send<ApiKey>(ctx, "POST", "/api/api-keys", { key, label: opts.label || "Default" });
    if (ctx.json) return printJson(saved);
    display.success(`Key sk-ant-····${saved.key_last4} connected. Unlimited runs, and they count on the leaderboard.\n`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) throw new Error(e.message);
    throw e;
  }
}

/** kodwai key remove <id> */
export async function keyRemove(id: string | undefined, opts: CtxOptions & { yes?: boolean }): Promise<void> {
  if (!id) throw new Error("Which key? kodwai key remove <id>   (ids: kodwai key)");
  const ctx = await authedCtx(opts);
  if (!opts.yes) {
    if (!isInteractive()) throw new Error("Run `kodwai key remove <id> --yes` to confirm without a terminal prompt.");
    if (!(await confirm("  Remove this key? Runs after this use your free runs, if any are left. (y/N) "))) {
      display.info("  Kept it.");
      return;
    }
  }
  try {
    await send(ctx, "DELETE", `/api/api-keys/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`No key "${id}" on your account. See them with: kodwai key`);
    throw e;
  }
  if (ctx.json) return printJson({ removed: id });
  display.success("Key removed.\n");
}

const FEEDBACK_CATEGORIES: Record<string, string> = {
  bug: "bug_report",
  bug_report: "bug_report",
  feature: "feature_request",
  feature_request: "feature_request",
  improvement: "improvement",
  general: "general",
};

/** kodwai feedback "<text>": tell the kodwai team something. The founder reads every one. */
export async function sendFeedback(text: string | undefined, opts: CtxOptions & { category?: string; rating?: string }): Promise<void> {
  const description = (text || "").trim();
  if (description.length < 10) throw new Error('Say a bit more (10 characters at least): kodwai feedback "..." [--category bug|feature|improvement|general] [--rating 1-5]');
  if (description.length > 5000) throw new Error("Feedback is limited to 5000 characters.");
  const category = FEEDBACK_CATEGORIES[(opts.category || "general").toLowerCase()];
  if (!category) throw new Error("--category must be one of: bug, feature, improvement, general.");
  const body: Record<string, unknown> = { category, description, page_url: "cli" };
  if (opts.rating !== undefined) body.rating = intFlag("--rating", opts.rating, 0, 1, 5);
  const ctx = await authedCtx(opts);
  const saved = await send(ctx, "POST", "/api/feedback/platform", body);
  if (ctx.json) return printJson(saved);
  display.success("Sent. Replies show up in: kodwai feedback list\n");
}

/** kodwai feedback list: what you've sent and the replies. */
export async function listFeedback(opts: CtxOptions): Promise<void> {
  const ctx = await authedCtx(opts);
  const items = await get<{ category: string; status: string; rating?: number | null; description: string; created_at: string; admin_response?: string | null; admin_responded_at?: string | null }[]>(ctx, "/api/feedback/platform/me?limit=50");
  if (ctx.json) return printJson(items);
  heading(`Your feedback · ${items.length} sent · ${items.filter((i) => i.admin_response).length} answered`);
  if (items.length === 0) {
    display.info('  Nothing yet. Send some: kodwai feedback "..."\n');
    return;
  }
  for (const i of items) {
    blank();
    console.log(`  ${chalk.dim(day(i.created_at))}  ${i.category.replace("_", " ")} · ${i.status}${i.rating ? ` · ${i.rating}/5` : ""}`);
    console.log(`  ${i.description.slice(0, 300)}`);
    if (i.admin_response) console.log(chalk.green(`  ↳ ${i.admin_response.slice(0, 500)}`) + chalk.dim(`  (${day(i.admin_responded_at)})`));
  }
  blank();
}

const PAGES: Record<string, string> = {
  home: "/dev/challenges",
  challenges: "/dev/challenges",
  leaderboard: "/dev/leaderboard",
  league: "/dev/league",
  events: "/dev/events",
  sprint: "/dev/sprint",
  quests: "/dev/quests",
  badges: "/dev/badges",
  profile: "/dev/profile",
  wrapped: "/dev/wrapped",
  submissions: "/dev/submissions",
  settings: "/dev/settings",
  feedback: "/dev/settings/feedback",
};

/** kodwai open [page|challenge-slug]: open a kodwai page in the browser. */
export async function openPage(target: string | undefined, opts: CtxOptions): Promise<void> {
  const ctx = await publicCtx(opts);
  const key = (target || "home").toLowerCase();
  const path = PAGES[key] ?? `/dev/challenges/${encodeURIComponent(target!)}`;
  const url = `${ctx.webUrl}${path}`;
  openBrowser(url);
  if (ctx.json) return printJson({ opened: url });
  display.info(`\n  Opened ${url}\n`);
}

export const OPEN_PAGES = Object.keys(PAGES);
