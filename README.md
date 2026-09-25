# @kodwai/cli

The official CLI for [kodwai](https://www.kodwai.com), the AI-agent coding challenge platform for developers.

## What is kodwai?

kodwai is a platform where developers solve real coding challenges on their own machine with their own AI coding agent (Claude Code, Cursor, or Codex) and get scored on how well they direct the agent, across three axes: Direction, Outcome, and Lift.

## Getting Started

### Sign in

```bash
kodwai login
```

This opens your browser, you approve the sign-in on kodwai, and the CLI stores a
token in `~/.kodwai/config.json`. It's the standard browser (OAuth loopback) flow:
the CLI starts a temporary local server, the browser hands back a one-time code,
and the CLI exchanges it for your token.

```bash
kodwai whoami     # show the signed-in account
kodwai logout     # sign out of this device
```

To **switch accounts**, run `kodwai login` again (or `kodwai logout` first) and
choose "Use a different account" in the browser.

You don't have to log in first: `challenge` and `submit` will trigger the same
browser sign-in automatically if you're not signed in.

### Start a challenge

```bash
npx @kodwai/cli challenge <slug>
```

This will:
1. Sign you in via the browser if needed (or use your stored token)
2. Ask which AI agent you'll use (Claude Code, Cursor, or Codex)
3. Create a workspace with the problem statement, starter files and tests, and init a git repo
4. Start the timer

Work with your AI agent in your own terminal, then submit:

```bash
npx @kodwai/cli submit
```

Your code, git history, test results, and AI agent traces are collected and scored.

### How scoring works

Each submission gets a score from 0 to 100 across three axes:

- **Direction**: how you steer, verify, and decompose.
- **Outcome**: what shipped, replayed and stress-tested to prove it holds.
- **Lift**: how far you beat a solo AI, not just that you passed.

Direction carries the most weight. Passing tests is necessary but not sufficient. Every signal cites its own evidence from your transcript, commits, and test runs, and the score comes with a confidence interval. More at [kodwai.com/ai-collaboration-score](https://www.kodwai.com/ai-collaboration-score).

Every account gets 3 free submissions scored on kodwai's own Anthropic key. After that, connect your own Anthropic API key in Settings for unlimited submissions. The key is encrypted at rest and only used to score your own work.

### Run an interview session

If your interviewer sent you an invite email, use the session ID and token from the email:

```bash
npx @kodwai/cli start <session-id> --token <session-token>
```

This will:
1. Fetch your problem statement and time limit from kodwai
2. Set up a sandboxed workspace
3. Start the timer
4. Launch Claude Code (the interviewer pays for usage via a sandboxed key)

When time runs out or you type `/exit` in Claude Code, your session is auto-uploaded and AI-scored against the interviewer's rubric.

### Commands

```
kodwai login                     Sign in via your browser
kodwai logout                    Sign out of this device
kodwai whoami                    Show the signed-in account
kodwai challenge <id-or-slug>    Start a developer coding challenge
kodwai submit                    Submit your challenge solution
kodwai start <session-id>        Join an interview session

Options:
  --local                        Use local dev (API localhost:8000, web localhost:3000)
  --api-url <url>                Override API URL
  --web-url <url>                Override web app URL (browser sign in)
  --token <token>                Session token (interview mode)
```

### Local development

By default the CLI talks to production. To target a local stack, use `--local`
(or set `KODWAI_API_URL`). The browser sign-in URL follows the API host, so a
local API opens `http://localhost:3000`:

```bash
kodwai login --local
# equivalent:
kodwai login --api-url http://localhost:8000
# or, to apply to every command in the shell:
export KODWAI_API_URL=http://localhost:8000
```

## Requirements

- **Node.js 20+**
- **Git** (auto-installed if missing)
- An AI coding agent: Claude Code, Cursor, or Codex

## Privacy

kodwai only collects data from your challenge workspace:
- Code files from the challenge directory
- Git history from the challenge session
- AI agent traces scoped to the challenge time window
- No data from other projects or sessions

The CLI source is publicly available. [View the source](https://github.com/kodwai/cli).

## Links

- [Website](https://www.kodwai.com)
- [Challenges](https://www.kodwai.com/challenges)
- [Leaderboard](https://app.kodwai.com/dev/leaderboard)
- [For hiring teams](https://www.kodwai.com/hiring)

## License

This project is licensed under the **PolyForm Noncommercial License 1.0.0**.

You may use, modify, and distribute it for personal, educational, research, and noncommercial purposes. **Commercial use, including using this code to operate or promote your own product, is not permitted** without a separate commercial license from kodwai.

See [LICENSE](LICENSE) for the full text. For commercial licensing inquiries, contact **hakan@ksenda.com**.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).
