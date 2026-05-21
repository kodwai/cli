import { execSync } from "node:child_process";
import crossSpawn from "cross-spawn";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfig } from "./config.js";
import type { createEventSender } from "../streaming/event-sender.js";
import type { createTimer } from "./timer.js";
import { ensureGit } from "../utils/git.js";

function findClaudePath(): string | null {
  const isWin = process.platform === "win32";

  // Try to find claude in PATH
  try {
    const result = execSync(
      isWin ? "where claude.cmd 2>nul || where claude 2>nul" : "which claude",
      { encoding: "utf-8", timeout: 5000 },
    ).trim().split("\n")[0];
    if (result) return result;
  } catch {
    // not in PATH
  }

  // On Windows, check npm global bin directly (PATH may not be updated)
  if (isWin) {
    try {
      const npmBin = execSync("npm bin -g", { encoding: "utf-8", timeout: 5000 }).trim();
      const candidates = [
        join(npmBin, "claude.cmd"),
        join(npmBin, "claude.exe"),
        join(npmBin, "claude"),
      ];
      for (const p of candidates) {
        try {
          execSync(`"${p}" --version`, { stdio: "ignore", timeout: 10000 });
          return p;
        } catch {
          // try next
        }
      }
    } catch {
      // npm bin failed
    }
  }

  return null;
}

function findGitBashPath(): string | null {
  // Check env var first
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  }

  // Check common locations
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
  ];

  for (const p of candidates) {
    try {
      execSync(`"${p}" --version`, { stdio: "ignore", timeout: 5000 });
      return p;
    } catch {
      // try next
    }
  }

  // Try to find git in PATH and derive bash path
  try {
    const gitPath = execSync("where git", { encoding: "utf-8", timeout: 5000 }).trim().split("\n")[0];
    // git is typically at ...\Git\cmd\git.exe, bash is at ...\Git\bin\bash.exe
    const bashPath = gitPath.replace(/\\cmd\\git\.exe$/i, "\\bin\\bash.exe");
    execSync(`"${bashPath}" --version`, { stdio: "ignore", timeout: 5000 });
    return bashPath;
  } catch {
    // not found
  }

  return null;
}

function ensureGitInPath(): void {
  // On Windows, Git may be installed but not in the current process PATH
  // Add common Git install locations proactively
  if (process.platform === "win32") {
    const gitPaths = [
      "C:\\Program Files\\Git\\cmd",
      "C:\\Program Files\\Git\\bin",
      "C:\\Program Files (x86)\\Git\\cmd",
      "C:\\Program Files (x86)\\Git\\bin",
      `${process.env.LOCALAPPDATA}\\Programs\\Git\\cmd`,
      `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin`,
    ];
    const currentPath = process.env.PATH || "";
    const missing = gitPaths.filter(p => !currentPath.includes(p));
    if (missing.length > 0) {
      process.env.PATH = missing.join(";") + ";" + currentPath;
    }
  }
}

function isGitInstalled(): boolean {
  ensureGitInPath();
  try {
    execSync("git --version", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    // On macOS, git may exist but fail due to Xcode license not accepted
    if (process.platform === "darwin") {
      try {
        execSync("which git", { stdio: "ignore", timeout: 3000 });
        // Git binary exists — try to accept Xcode license
        console.log("\n⚙  Accepting Xcode license...\n");
        try {
          execSync("sudo xcodebuild -license accept", { stdio: "inherit", timeout: 30000 });
        } catch {
          // Try without sudo
          try {
            execSync("xcodebuild -license accept", { stdio: "inherit", timeout: 30000 });
          } catch {
            // ignore — user may need to do it manually
          }
        }
        // Check again after license accept
        try {
          execSync("git --version", { stdio: "ignore", timeout: 5000 });
          return true;
        } catch {
          // still failing
        }
      } catch {
        // git binary not found at all
      }
    }
    return false;
  }
}

function installGit(): void {
  const platform = process.platform;

  if (platform === "win32") {
    // Try winget (available on all Windows 11 and most Windows 10)
    try {
      execSync("winget --version", { stdio: "ignore", timeout: 5000 });
      console.log("\n⚙  Git not found. Installing Git for Windows via winget...\n");
      try {
        execSync("winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements", {
          stdio: "inherit",
          timeout: 300000,
        });
      } catch {
        // winget exits non-zero if already installed ("no upgrade found") — that's fine
      }
      console.log("\n✓ Git for Windows ready.\n");

      // Add Git's default install paths to current process PATH
      // so we can find it without restarting the terminal
      const gitPaths = [
        "C:\\Program Files\\Git\\cmd",
        "C:\\Program Files\\Git\\bin",
        "C:\\Program Files (x86)\\Git\\cmd",
        "C:\\Program Files (x86)\\Git\\bin",
      ];
      const currentPath = process.env.PATH || "";
      const newPaths = gitPaths.filter(p => !currentPath.includes(p));
      if (newPaths.length > 0) {
        process.env.PATH = newPaths.join(";") + ";" + currentPath;
      }

      return;
    } catch {
      // winget not available or failed
    }
    throw new Error(
      "Git is required but could not be installed automatically.\n\n" +
      "Please install Git for Windows: https://git-scm.com/downloads/win\n" +
      "Then run this command again."
    );
  }

  if (platform === "darwin") {
    // macOS: try xcode-select (installs Git via Command Line Tools)
    try {
      console.log("\n⚙  Git not found. Installing via Xcode Command Line Tools...\n");
      execSync("xcode-select --install", { stdio: "inherit", timeout: 300000 });
      console.log("\n✓ Git installed successfully.\n");
      return;
    } catch {
      // xcode-select failed, try Homebrew
    }
    try {
      execSync("brew --version", { stdio: "ignore", timeout: 5000 });
      console.log("\n⚙  Git not found. Installing via Homebrew...\n");
      execSync("brew install git", { stdio: "inherit", timeout: 300000 });
      console.log("\n✓ Git installed successfully.\n");
      return;
    } catch {
      // Homebrew not available
    }
    throw new Error(
      "Git is required but could not be installed automatically.\n\n" +
      "Please install Git: https://git-scm.com/downloads/mac\n" +
      "Or run: xcode-select --install\n" +
      "Then run this command again."
    );
  }

  // Linux — try common package managers
  const linuxManagers = [
    { check: "apt", cmd: "sudo apt install -y git" },
    { check: "dnf", cmd: "sudo dnf install -y git" },
    { check: "yum", cmd: "sudo yum install -y git" },
    { check: "pacman", cmd: "sudo pacman -S --noconfirm git" },
    { check: "apk", cmd: "sudo apk add git" },
    { check: "zypper", cmd: "sudo zypper install -y git" },
  ];

  for (const { check, cmd } of linuxManagers) {
    try {
      execSync(`which ${check}`, { stdio: "ignore", timeout: 3000 });
      console.log(`\n⚙  Git not found. Installing via ${check}...\n`);
      execSync(cmd, { stdio: "inherit", timeout: 300000 });
      console.log("\n✓ Git installed successfully.\n");
      return;
    } catch {
      // try next
    }
  }

  throw new Error(
    "Git is required but could not be installed automatically.\n\n" +
    "Please install Git using your package manager and run this command again."
  );
}

function ensurePrerequisites(): void {
  // Check Git is installed (required on all platforms)
  ensureGit();

  // Windows-specific: ensure Git Bash is found and CLAUDE_CODE_GIT_BASH_PATH is set
  if (process.platform === "win32") {
    let bashPath = findGitBashPath();
    if (!bashPath) {
      throw new Error(
        "Git is installed but Git Bash could not be found.\n" +
        "Try closing and reopening your terminal, then run the command again."
      );
    }
    if (!process.env.CLAUDE_CODE_GIT_BASH_PATH) {
      process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
      console.log(`✓ Found Git Bash at: ${bashPath}`);
    }
  }
}

async function ensureClaudeInstalled(): Promise<string> {
  // Check prerequisites (Git on all platforms, Git Bash on Windows)
  ensurePrerequisites();

  let cmd = findClaudePath();
  if (cmd) return cmd;

  console.log("\n⚙  Claude Code not found. Installing...\n");
  try {
    execSync("npm install -g @anthropic-ai/claude-code", { stdio: "inherit" });
    console.log("\n✓ Claude Code installed successfully.\n");

    // Add npm global bin to PATH so we can find claude immediately
    try {
      const npmBin = execSync("npm bin -g", { encoding: "utf-8", timeout: 5000 }).trim();
      if (npmBin && !process.env.PATH?.includes(npmBin)) {
        const sep = process.platform === "win32" ? ";" : ":";
        process.env.PATH = npmBin + sep + (process.env.PATH || "");
      }
    } catch {
      // ignore
    }
  } catch {
    throw new Error(
      "Failed to install Claude Code automatically.\n" +
      "Please install it manually: npm install -g @anthropic-ai/claude-code"
    );
  }

  cmd = findClaudePath();
  if (cmd) return cmd;

  throw new Error(
    "Claude Code was installed but could not be found.\n" +
    "Try closing and reopening your terminal, then run the command again."
  );
}

interface SessionResult {
  reason: "candidate_finished" | "timer_expired" | "budget_exceeded" | "error";
  totalCostUsd?: number;
  totalTokens?: number;
}

export async function launchClaude(
  config: SessionConfig,
  workspacePath: string,
  _eventSender: ReturnType<typeof createEventSender>,
  timer: ReturnType<typeof createTimer>,
  baseUrl: string,
): Promise<SessionResult> {
  await mkdir(join(workspacePath, ".claude"), { recursive: true });

  const eventsUrl = `${baseUrl}/api/sessions/${config.session_id}/events`;

  // Write a Node.js hook script that reads stdin, signs, and POSTs the hook
  // event to our API. Assistant text (Claude's responses) is captured by the
  // transcript-watcher in the long-running CLI process, not here — Claude Code
  // doesn't flush the current turn's assistant message to JSONL before the
  // Stop hook fires, so trying to read it in-hook always misses the latest one.
  const hookScriptPath = join(workspacePath, ".claude", "kodwai-hook.mjs");
  await writeFile(hookScriptPath, `
import { createHmac } from "node:crypto";

const secret = ${JSON.stringify(config.webhook_secret)};
const eventsUrl = ${JSON.stringify(eventsUrl)};
const sessionId = ${JSON.stringify(config.session_id)};

let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const hookData = JSON.parse(input);
    const event = {
      event_type: hookData.hook_event_name || hookData.event || "unknown",
      data: hookData,
      timestamp: new Date().toISOString(),
    };
    const body = JSON.stringify(event);
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    await fetch(eventsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kodwai-Signature": "sha256=" + sig,
        "X-Kodwai-Session": sessionId,
      },
      body,
    }).catch(() => {});
  } catch {}
});
`, "utf-8");

  // Write settings with hooks
  const settingsPath = join(workspacePath, ".claude", "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    permissions: {
      allow: config.allowed_tools ?? [],
      deny: config.disallowed_tools ?? [],
    },
    hooks: {
      UserPromptSubmit: [{
        hooks: [{ type: "command", command: `node "${hookScriptPath}"` }],
      }],
      Stop: [{
        hooks: [{ type: "command", command: `node "${hookScriptPath}"` }],
      }],
      PostToolUse: [{
        hooks: [{ type: "command", command: `node "${hookScriptPath}"` }],
      }],
    },
  }, null, 2), "utf-8");

  // Write CLAUDE.md with interview context
  await writeFile(join(workspacePath, "CLAUDE.md"), [
    `# Kodwai Interview Session`,
    ``,
    `This is a timed technical interview (${config.time_limit_minutes} minutes).`,
    `The problem statement is in PROBLEM.md.`,
    `Help the candidate solve the problem. Be collaborative and helpful.`,
  ].join("\n"), "utf-8");

  // Check if Claude Code is installed, auto-install if not
  const claudeCmd = await ensureClaudeInstalled();

  return new Promise<SessionResult>((resolve) => {
    // Use cross-spawn — handles .cmd files, argument quoting, and PATH on Windows
    const child = crossSpawn(claudeCmd, [], {
      cwd: workspacePath,
      stdio: "inherit",
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.api_key,           // Session token (not real key)
        ANTHROPIC_BASE_URL: config.proxy_base_url,   // Routes through Kodwai proxy
      },
    });

    let resolved = false;

    function finish(reason: SessionResult["reason"]) {
      if (resolved) return;
      resolved = true;
      timer.stop();
      resolve({ reason });
    }

    timer.onExpired(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
      finish("timer_expired");
    });

    child.on("exit", () => {
      if (!resolved) {
        finish("candidate_finished");
      }
    });

    child.on("error", (err) => {
      console.error(`\n❌ Failed to launch Claude Code: ${err.message}`);
      if (err.message.includes("ENOENT")) {
        console.error("   Try closing and reopening your terminal, then run the command again.\n");
      }
      finish("error");
    });
  });
}
