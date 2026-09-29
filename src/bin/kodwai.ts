import { fileURLToPath } from "node:url";
import { startSession } from "../commands/start.js";
import { startChallenge } from "../commands/challenge.js";
import { submitChallenge } from "../commands/submit.js";
import { login } from "../commands/login.js";
import { logout } from "../commands/logout.js";
import { whoami } from "../commands/whoami.js";
import { status } from "../commands/status.js";
import { abandon } from "../commands/abandon.js";
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
const VALUE_FLAGS = new Set(["--api-url", "--web-url", "--token", "--agent"]);

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

  Challenges:
    kodwai challenge <slug>          Start a challenge (creates a kodwai-<slug> folder)
      --agent <name>                 Skip the prompt: claude-code, cursor or codex
    kodwai status                    Time left and files so far (or your score, once submitted)
    kodwai submit                    Submit the challenge in this folder and show your score
      --yes, -y                      Don't ask for confirmation
      --no-wait                      Don't wait for the score
    kodwai abandon                   Drop the challenge in progress without scoring it

  Account:
    kodwai login                     Sign in via your browser
    kodwai logout                    Sign out of this device
    kodwai whoami                    Show the signed-in account

  Interviews:
    kodwai start <session-id> --token <token>
                                     Join an interview session from your invite

  Options:
    --local                          Use local dev (API localhost:8000, web localhost:3000)
    --api-url <url>                  Override API URL (or set KODWAI_API_URL)
    --web-url <url>                  Override web app URL (browser sign in)
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

const COMMANDS = ["challenge", "submit", "status", "abandon", "login", "logout", "whoami", "start", "help"];

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

  const [command, operand] = positionals();

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
      return startChallenge(operand, apiUrlFlag(), getFlag("--agent"));
    case "start":
      if (!operand) throw new Error("Usage: kodwai start <session-id> --token <token>  (both are in your invite email)");
      return startSession(operand, apiUrlFlag(), getFlag("--token"));
    default: {
      const guess = COMMANDS.find((c) => editDistance(c, command.toLowerCase()) <= 2);
      throw new Error(`Unknown command "${command}".${guess ? ` Did you mean \`kodwai ${guess}\`?` : ""} Run \`kodwai help\` for the list.`);
    }
  }
}

main().catch(fail);
