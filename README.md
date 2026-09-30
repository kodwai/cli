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
npx @kodwai/cli@latest challenge <slug>
```

This will:
1. Sign you in via the browser if needed (or use your stored token)
2. Ask which AI agent you'll use (Claude Code, Cursor, or Codex)
3. Create a workspace with the problem statement, starter files and tests, and init a git repo
4. Start the timer

Skip the agent question with `--agent claude-code|cursor|codex`.

Work with your AI agent in your own terminal. From anywhere inside the workspace:

```bash
kodwai status     # time left and the files collected so far
kodwai submit     # submit, then wait for your score in the terminal
```

Your code, git history, test results, and AI agent traces are collected and scored.
Dependencies, build output, lockfiles and secret files (`.env`, keys) are never sent,
and `.gitignore` is respected. `kodwai submit --yes` skips the confirmation (for scripts),
and `--no-wait` prints the results link instead of waiting for the score.

Only one challenge can be in progress at a time. To drop one without scoring it:

```bash
kodwai abandon
```

### From inside your agent

The [kodwai plugin](https://github.com/kodwai/plugin) for Claude Code, Codex and Cursor adds `/kodwai:challenge`, `/kodwai:status`, `/kodwai:submit` and `/kodwai:abandon`, and links your agent session to the challenge so `submit` reads its exact transcript.

```
/plugin marketplace add kodwai/plugin      # Claude Code
/plugin install kodwai@kodwai
```

Without the plugin, running `kodwai challenge` from inside Claude Code or Codex still links that session: the CLI reads the session id the agent gives its shell commands. When no terminal is attached, the agent is detected automatically, and `--accept-data-notice` accepts the data collection notice after you've agreed to it in the chat.

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
npx @kodwai/cli@latest start <session-id> --token <session-token>
```

This will:
1. Fetch your problem statement and time limit from kodwai
2. Set up a sandboxed workspace
3. Start the timer
4. Launch Claude Code (the interviewer pays for usage via a sandboxed key)

When time runs out or you type `/exit` in Claude Code, your session is auto-uploaded and AI-scored against the interviewer's rubric.

### Commands

```
Discover
  kodwai challenges                Browse challenges (your best score on the ones you solved)
    --search <text> --difficulty easy|medium|hard --category <name>
    --sort newest|popular|difficulty --limit <n> --page <n>
  kodwai challenges categories     Categories and how many challenges each has
  kodwai info <slug>               Spec, how it's scored, your runs, top 10 (--verbose: signals)
  kodwai daily                     Challenge of the Day
  kodwai sprint                    This week's sprint and standings
  kodwai events [slug]             Events, or one event's board

Standings
  kodwai leaderboard               All-time board with your rank
    --agent claude-code|cursor|codex --model <slug> --category <name> --page <n>
  kodwai leaderboard <slug>        One challenge's board
  kodwai leaderboard me            Your best score on each ranked challenge
  kodwai leaderboard filters       Values for --model and --category
  kodwai league                    Your weekly league: division, rank, zones

You
  kodwai profile [username]        Tier, Elo, level, rank, streak, mastery, badges, runs
  kodwai profile edit              --bio --github --x --linkedin --website
  kodwai badges [--all]            Badges held, progress and rarity
  kodwai quests                    Daily and weekly quests
  kodwai quests claim [key|all]    Bank finished quests' XP
  kodwai wrapped                   Your kodwai Wrapped
  kodwai card [--theme <t>]        README rank card (dark, light, signal)

Challenges and runs
  kodwai challenge <slug>          Start a challenge (creates a kodwai-<slug> folder)
  kodwai status                    Time left and files so far, or your score
  kodwai submit                    Submit your challenge solution
  kodwai abandon                   Drop the challenge in progress without scoring it
  kodwai submissions               Your runs (--challenge <slug> --limit <n> --page <n>)
  kodwai result [id]               One run in full: score, axes, moments (--verbose: evidence)
  kodwai share [id]                Public share link for a scored run
  kodwai rate [id] --overall 1-5   Rate the challenge (--difficulty --clarity --comment)
  kodwai delete <id>               Delete a run, or stop one in progress

Account
  kodwai login | logout | whoami   Sign in via your browser, sign out, show the account
  kodwai username [name]           Show or set your username
  kodwai key                       Your scoring key and free runs
  kodwai key add                   Connect your Anthropic key (hidden prompt, never an argument)
  kodwai key remove <id>           Remove a key
  kodwai feedback "<text>"         Send feedback (--category bug|feature|improvement|general --rating 1-5)
  kodwai feedback list             Your feedback and the replies
  kodwai open [page|slug]          Open a kodwai page in the browser

Interviews
  kodwai start <session-id>        Join an interview session

Options:
  --json                         Raw JSON output (platform commands), for scripts and agents
  --local                        Use local dev (API localhost:8000, web localhost:3000)
  --api-url <url>                Override API URL
  --web-url <url>                Override web app URL (browser sign in)
  --token <token>                Session token (interview mode)
  --agent <name>                 claude-code, cursor or codex (challenge)
  --accept-data-notice           Accept the data collection notice without a prompt (challenge)
```

Public commands (`challenges`, `info`, `leaderboard`, `events`, `profile <username>`) work signed out. The rest sign you in through the browser the first time.

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
- AI agent traces scoped to the challenge time window, from sessions run in the workspace or linked to it
- No data from other projects or sessions

Text your agent injects on its own (environment details, instruction files, skill bodies) is dropped from the trace: only what you and the agent said is sent.

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
