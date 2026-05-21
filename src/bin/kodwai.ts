import { startSession } from "../commands/start.js";
import { startChallenge } from "../commands/challenge.js";
import { submitChallenge } from "../commands/submit.js";

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

if (command === "start" && args[1]) {
  // Interview session mode (candidate joins via invite)
  startSession(args[1], getFlag("--api-url"), getFlag("--token"))
    .catch((err) => {
      console.error(`\n❌ ${err.message}`);
      process.exit(1);
    });
} else if (command === "challenge" && args[1]) {
  // Developer challenge mode
  startChallenge(args[1], getFlag("--api-url"))
    .catch((err) => {
      console.error(`\n❌ ${err.message}`);
      process.exit(1);
    });
} else if (command === "submit") {
  // Submit local challenge
  submitChallenge()
    .catch((err) => {
      console.error(`\n❌ ${err.message}`);
      process.exit(1);
    });
} else {
  console.log(`
  kodwai — AI-agent coding challenges & interview sessions

  Commands:
    kodwai challenge <id-or-slug>    Start a developer coding challenge
    kodwai submit                    Submit your challenge solution
    kodwai start <session-id>        Join an interview session (use the
                                     invite link's --token to authenticate)

  Options:
    --api-url <url>                  Override API URL
    --token <token>                  Session token (interview mode)
  `);
  process.exit(command ? 1 : 0);
}
