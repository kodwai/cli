import { execFileSync, execSync } from "node:child_process";

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

export function ensureGit(): void {
  if (!isGitInstalled()) {
    installGit();

    // Verify after install
    if (!isGitInstalled()) {
      throw new Error(
        "Git was installed but could not be found.\n" +
        "Try closing and reopening your terminal, then run the command again."
      );
    }
  }
}

// Commit identity for commits the CLI makes itself. Passed with -c so a machine
// with no user.name/user.email configured (fresh laptops, CI boxes) doesn't make
// `git commit` fail, and so a global commit.gpgsign=true doesn't prompt or fail.
const CLI_GIT_CONFIG = [
  "-c", "user.name=kodwai",
  "-c", "user.email=cli@kodwai.com",
  "-c", "commit.gpgsign=false",
  "-c", "core.autocrlf=false",
];

function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: opts.maxBuffer ?? 20_000_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ?? process.env,
    timeout: 60_000,
  });
}

/** git init + one commit of the starter files. Safe on machines with no git identity or with signing on. */
export function initWorkspaceRepo(cwd: string): void {
  ensureGitInPath();
  git(cwd, ["init", "-q"]);
  git(cwd, ["add", "-A"]);
  // Identity env vars outrank every git config level, including stray empty ones.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "kodwai",
    GIT_AUTHOR_EMAIL: "cli@kodwai.com",
    GIT_COMMITTER_NAME: "kodwai",
    GIT_COMMITTER_EMAIL: "cli@kodwai.com",
  };
  git(cwd, [...CLI_GIT_CONFIG, "commit", "-q", "--no-verify", "--allow-empty", "-m", "Initial: challenge starter files"], { env });
}

export interface GitData {
  diff: string | null;
  log: { hash: string; message: string; timestamp: string }[];
}

const MAX_DIFF_CHARS = 500_000;

/**
 * Everything that changed since the starter commit (committed, staged, unstaged
 * and new untracked files), plus the commit log. Uses a throwaway index file so
 * the developer's own staging area is never touched.
 */
export function collectGitData(cwd: string, tmpIndexPath: string): GitData {
  const data: GitData = { diff: null, log: [] };
  let root: string;
  try {
    root = git(cwd, ["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n").pop() || "";
  } catch {
    return data; // not a repo, or no commits yet
  }
  if (!root) return data;

  try {
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndexPath };
    git(cwd, ["read-tree", "HEAD"], { env });
    git(cwd, ["add", "-A"], { env });
    data.diff = git(cwd, ["diff", "--cached", root], { env }).slice(0, MAX_DIFF_CHARS);
  } catch {
    try {
      data.diff = git(cwd, ["diff", root]).slice(0, MAX_DIFF_CHARS);
    } catch {
      data.diff = null;
    }
  }

  try {
    const out = git(cwd, ["log", "--format=%H%x1f%s%x1f%aI%x1e"]);
    data.log = out
      .split("\x1e")
      .map((rec) => rec.trim())
      .filter(Boolean)
      .map((rec) => {
        const [hash, message, timestamp] = rec.split("\x1f");
        return { hash, message: message ?? "", timestamp: timestamp ?? "" };
      })
      .filter((c) => /^[0-9a-f]{7,64}$/.test(c.hash));
  } catch {
    data.log = [];
  }
  return data;
}
