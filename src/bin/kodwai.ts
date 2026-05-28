import { startSession } from "../commands/start.js";
import { startChallenge } from "../commands/challenge.js";
import { submitChallenge } from "../commands/submit.js";
import { login } from "../commands/login.js";
import { logout } from "../commands/logout.js";
import { whoami } from "../commands/whoami.js";

// Some terminals/keyboards autocorrect "--" into an em/en dash, so a flag like
// "--local" arrives as "—local" or "—-local". Normalize a leading run of dashes
// (when it contains a unicode dash) back to "--" so flags still work.
function normalizeLeadingDashes(arg: string): string {
  const run = arg.match(/^[-‒–—―]+/)?.[0];
  if (!run || !/[‒–—―]/.test(run)) return arg;
  return "--" + arg.slice(run.length);
}

const args = process.argv.slice(2).map(normalizeLeadingDashes);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

// `--local` is a shortcut for local development: API at localhost:8000 (the web
// URL then derives to localhost:3000). An explicit --api-url still overrides it.
const LOCAL_API_URL = "http://localhost:8000";
function apiUrlFlag(): string | undefined {
  return getFlag("--api-url") || (hasFlag("--local") ? LOCAL_API_URL : undefined);
}

const fail = (err: Error) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
};

if (command === "login") {
  // Browser-based sign in (also used to switch accounts)
  login(apiUrlFlag(), getFlag("--web-url")).catch(fail);
} else if (command === "logout") {
  // Sign out (clear stored token)
  logout().catch(fail);
} else if (command === "whoami") {
  // Show the currently signed-in account
  whoami(apiUrlFlag()).catch(fail);
} else if (command === "start" && args[1]) {
  // Interview session mode (candidate joins via invite)
  startSession(args[1], apiUrlFlag(), getFlag("--token")).catch(fail);
} else if (command === "challenge" && args[1]) {
  // Developer challenge mode
  startChallenge(args[1], apiUrlFlag()).catch(fail);
} else if (command === "submit") {
  // Submit local challenge
  submitChallenge().catch(fail);
} else {
  console.log(`
  kodwai — AI-agent coding challenges & interview sessions

  Commands:
    kodwai login                     Sign in via your browser
    kodwai logout                    Sign out of this device
    kodwai whoami                    Show the signed-in account
    kodwai challenge <id-or-slug>    Start a developer coding challenge
    kodwai submit                    Submit your challenge solution
    kodwai start <session-id>        Join an interview session (use the
                                     invite link's --token to authenticate)

  Options:
    --local                          Use local dev (API localhost:8000, web localhost:3000)
    --api-url <url>                  Override API URL
    --web-url <url>                  Override web app URL (browser sign in)
    --token <token>                  Session token (interview mode)
  `);
  process.exit(command ? 1 : 0);
}
