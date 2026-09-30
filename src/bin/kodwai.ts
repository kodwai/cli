import { fileURLToPath } from "node:url";
import { startSession } from "../commands/start.js";
import { startChallenge } from "../commands/challenge.js";
import { submitChallenge } from "../commands/submit.js";
import { login } from "../commands/login.js";
import { logout } from "../commands/logout.js";
import { whoami } from "../commands/whoami.js";
import { status } from "../commands/status.js";
import { abandon } from "../commands/abandon.js";
import { listChallenges, listCategories, challengeInfo, daily, sprint, events } from "../commands/browse.js";
import { leaderboard, league } from "../commands/standings.js";
import { profile, editProfile, badges, quests, claimQuest, wrapped, card } from "../commands/me.js";
import { submissions, result, share, rate, deleteRun } from "../commands/runs.js";
import { setUsername, keyStatus, keyAdd, keyRemove, sendFeedback, listFeedback, openPage } from "../commands/account.js";
import { offerUpdate, runUpdateCheck } from "../utils/update-notifier.js";
import { ApiError } from "../utils/api.js";

declare const __CLI_VERSION__: string;
const VERSION = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "dev";

// Some terminals/keyboards autocorrect "--" into an em/en dash, so a flag like
// "--local" arrives as "—local" or "—-local". Normalize a leading run of dashes
// (when it contains a unicode dash) back to "--" so flags still work.
function normalizeLeadingDashes(arg: string): string {
  const run = arg.match(/^[-‒–—―]+/)?.[0];
  if (!run || !/[‒–—―]/.test(run)) return arg;
  return "--" + arg.slice(run.length);
}

const args = process.argv.slice(2).map(normalizeLeadingDashes);
// Flags that take a value; everything else starting with "-" is a boolean.
const VALUE_FLAGS = new Set([
  "--api-url", "--web-url", "--token", "--agent",
  // platform commands
  "--search", "--difficulty", "--category", "--sort", "--limit", "--page", "--model", "--theme",
  "--challenge", "--overall", "--clarity", "--comment", "--rating", "--label",
  "--bio", "--github", "--x", "--linkedin", "--website",
]);

function getFlag(name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) throw new Error(`${name} needs a value, e.g. ${name} <value>`);
  return value;
}

function hasFlag(...names: string[]): boolean {
  return names.some((n) => args.includes(n));
}

/** Positional arguments (command and its operands), with flags and their values removed. */
function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

// `--local` is a shortcut for local development: API at localhost:8000 (the web
// URL then derives to localhost:3000). An explicit --api-url still overrides it.
const LOCAL_API_URL = "http://localhost:8000";
function apiUrlFlag(): string | undefined {
  return getFlag("--api-url") || (hasFlag("--local") ? LOCAL_API_URL : undefined);
}

const BIN_PATH = fileURLToPath(import.meta.url);

const fail = async (err: unknown) => {
  // The API refuses CLIs older than its minimum: offer the update right here.
  if (err instanceof ApiError && err.status === 426) {
    console.error(`\n⚠ ${err.message}`);
    await offerUpdate(BIN_PATH, args, true).catch(() => {});
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n❌ ${message}\n`);
  if (process.env.KODWAI_DEBUG && err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
};

function printHelp() {
  console.log(`
  kodwai ${VERSION}: AI-agent coding challenges & interview sessions

  Discover:
    kodwai challenges                Browse challenges (your best score on the ones you solved)
      --search <text> --difficulty easy|medium|hard --category <name>
      --sort newest|popular|difficulty --limit <n> --page <n>
    kodwai challenges categories     Categories and how many challenges each has
    kodwai info <slug>               Spec, how it's scored, your runs, top 10 (--verbose: signals)
    kodwai daily                     Challenge of the Day
    kodwai sprint                    This week's sprint and standings
    kodwai events [slug]             Events, or one event's board

  Standings:
    kodwai leaderboard               All-time board with your rank
      --agent claude-code|cursor|codex --model <slug> --category <name> --page <n>
    kodwai leaderboard <slug>        One challenge's board
    kodwai leaderboard me            Your best score on each ranked challenge
    kodwai leaderboard filters       Values for --model and --category
    kodwai league                    Your weekly league: division, rank, zones

  You:
    kodwai profile [username]        Tier, Elo, level, rank, streak, mastery, badges, runs
    kodwai profile edit              --bio --github --x --linkedin --website
    kodwai badges [--all]            Badges held, progress and rarity
    kodwai quests                    Daily and weekly quests
    kodwai quests claim [key|all]    Bank finished quests' XP
    kodwai wrapped                   Your kodwai Wrapped
    kodwai card [--theme <t>]        README rank card (dark, light, signal)

  Runs:
    kodwai submissions               Your runs (--challenge <slug> --limit <n> --page <n>)
    kodwai result [id]               One run in full: score, axes, moments (--verbose: evidence)
    kodwai share [id]                Public share link for a scored run
    kodwai rate [id] --overall 1-5   Rate the challenge (--difficulty --clarity --comment)
    kodwai delete <id>               Delete a run, or stop one in progress

  Challenges:
    kodwai challenge <slug>          Start a challenge (creates a kodwai-<slug> folder)
      --agent <name>                 Skip the prompt: claude-code, cursor or codex
      --accept-data-notice           Accept the data collection notice without a prompt
    kodwai status                    Time left and files so far (or your score, once submitted)
    kodwai submit                    Submit the challenge in this folder and show your score
      --yes, -y                      Don't ask for confirmation
      --no-wait                      Don't wait for the score
    kodwai abandon                   Drop the challenge in progress without scoring it

  Account:
    kodwai login                     Sign in via your browser
    kodwai logout                    Sign out of this device
    kodwai whoami                    Show the signed-in account
    kodwai username [name]           Show or set your username
    kodwai key                       Your scoring key and free runs
    kodwai key add                   Connect your Anthropic key (hidden prompt)
    kodwai key remove <id>           Remove a key
    kodwai feedback "<text>"         Send feedback (--category bug|feature|improvement|general --rating 1-5)
    kodwai feedback list             Your feedback and the replies
    kodwai open [page|slug]          Open a kodwai page in the browser

  Interviews:
    kodwai start <session-id> --token <token>
                                     Join an interview session from your invite

  Options:
    --local                          Use local dev (API localhost:8000, web localhost:3000)
    --api-url <url>                  Override API URL (or set KODWAI_API_URL)
    --web-url <url>                  Override web app URL (browser sign in)
    --json                           Print raw JSON (platform commands)
    --version, -v                    Print the version
  `);
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

const COMMANDS = [
  "challenge", "submit", "status", "abandon", "login", "logout", "whoami", "start", "help",
  "challenges", "info", "daily", "sprint", "events", "leaderboard", "league", "profile", "badges", "quests",
  "wrapped", "card", "submissions", "result", "share", "rate", "delete", "username", "key", "feedback", "open",
];

async function main() {
  // Hidden entrypoint: the background update check (spawned detached). Must run
  // before the notifier wiring so it never recurses.
  if (args[0] === "__update-check") {
    await runUpdateCheck();
    return;
  }

  if (hasFlag("--version", "-v", "-V") && positionals().length === 0) {
    console.log(VERSION);
    return;
  }

  const [command, operand, operand2] = positionals();
  const common = { apiUrl: apiUrlFlag(), json: hasFlag("--json") };

  if (!command || command === "help" || hasFlag("--help", "-h")) {
    printHelp();
    return;
  }

  // When a newer CLI is published, offer to install it and re-run this command
  // on it. Waits at most ~1.5s for npm; any failure just keeps this version.
  await offerUpdate(BIN_PATH, args).catch(() => {});

  switch (command) {
    case "login":
      return login(apiUrlFlag(), getFlag("--web-url"));
    case "logout":
      return logout();
    case "whoami":
      return whoami(apiUrlFlag());
    case "status":
      return status(apiUrlFlag());
    case "abandon":
    case "stop":
      return abandon(apiUrlFlag(), hasFlag("--yes", "-y"));
    case "submit":
      return submitChallenge({ yes: hasFlag("--yes", "-y"), noWait: hasFlag("--no-wait") });
    case "challenge":
      if (!operand) throw new Error("Which challenge? Usage: kodwai challenge <slug>  (browse them at https://app.kodwai.com/dev/challenges)");
      return startChallenge(operand, apiUrlFlag(), getFlag("--agent"), { acceptNotice: hasFlag("--accept-data-notice") });
    case "start":
      if (!operand) throw new Error("Usage: kodwai start <session-id> --token <token>  (both are in your invite email)");
      return startSession(operand, apiUrlFlag(), getFlag("--token"));

    // Discover
    case "challenges":
      if (operand === "categories") return listCategories(common);
      return listChallenges({
        ...common,
        search: getFlag("--search") ?? operand,
        difficulty: getFlag("--difficulty"),
        category: getFlag("--category"),
        sort: getFlag("--sort"),
        limit: getFlag("--limit"),
        page: getFlag("--page"),
      });
    case "info":
      if (!operand) throw new Error("Which challenge? kodwai info <slug>   (list: kodwai challenges)");
      return challengeInfo(operand, { ...common, verbose: hasFlag("--verbose") });
    case "daily":
      return daily(common);
    case "sprint":
      return sprint(common);
    case "events":
    case "event":
      return events(operand, common);

    // Standings
    case "leaderboard":
    case "lb":
      return leaderboard(operand, {
        ...common,
        agent: getFlag("--agent"),
        model: getFlag("--model"),
        category: getFlag("--category"),
        limit: getFlag("--limit"),
        page: getFlag("--page"),
      });
    case "league":
      return league(common);

    // You
    case "profile":
      if (operand === "edit") {
        return editProfile(
          { bio: getFlag("--bio"), github: getFlag("--github"), x: getFlag("--x"), linkedin: getFlag("--linkedin"), website: getFlag("--website") },
          common,
        );
      }
      return profile(operand, common);
    case "badges":
      return badges({ ...common, all: hasFlag("--all") });
    case "quests":
      if (operand === "claim") return claimQuest(operand2, common);
      return quests(common);
    case "wrapped":
      return wrapped(common);
    case "card":
      return card({ ...common, theme: getFlag("--theme") });

    // Runs
    case "submissions":
    case "runs":
      return submissions({ ...common, challenge: getFlag("--challenge"), limit: getFlag("--limit"), page: getFlag("--page") });
    case "result":
      return result(operand, { ...common, verbose: hasFlag("--verbose") });
    case "share":
      return share(operand, common);
    case "rate":
      return rate(operand, {
        ...common,
        overall: getFlag("--overall"),
        difficulty: getFlag("--difficulty"),
        clarity: getFlag("--clarity"),
        comment: getFlag("--comment"),
      });
    case "delete":
      return deleteRun(operand, { ...common, yes: hasFlag("--yes", "-y") });

    // Account
    case "username":
      return setUsername(operand, common);
    case "key":
    case "keys":
      if (operand === "add") return keyAdd({ ...common, label: getFlag("--label") });
      if (operand === "remove" || operand === "rm") return keyRemove(operand2, { ...common, yes: hasFlag("--yes", "-y") });
      return keyStatus(common);
    case "feedback":
      if (operand === "list") return listFeedback(common);
      return sendFeedback(operand, { ...common, category: getFlag("--category"), rating: getFlag("--rating") });
    case "open":
      return openPage(operand, common);
    default: {
      const guess = COMMANDS.find((c) => editDistance(c, command.toLowerCase()) <= 2);
      throw new Error(`Unknown command "${command}".${guess ? ` Did you mean \`kodwai ${guess}\`?` : ""} Run \`kodwai help\` for the list.`);
    }
  }
}

main().catch(fail);
