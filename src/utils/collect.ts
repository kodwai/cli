import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

// Directories and files never worth sending: dependencies, build output, caches, VCS/agent state.
export const SKIP_DIRS = new Set([
  "node_modules", ".next", ".nuxt", "dist", "build", ".turbo", ".cache", ".parcel-cache",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", "env",
  "vendor", "target", ".gradle", ".git", ".claude", ".kodwai", ".idea", ".vscode", "coverage",
  ".svelte-kit", ".output", ".tox", ".terraform",
]);
const SKIP_EXTENSIONS = new Set([
  ".pyc", ".class", ".o", ".so", ".dylib", ".dll", ".exe", ".bin", ".wasm",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp",
  ".mp4", ".mov", ".mp3", ".wav", ".zip", ".tar", ".gz", ".tgz", ".7z", ".pdf",
  ".db", ".sqlite", ".sqlite3", ".map", ".woff", ".woff2", ".ttf", ".eot", ".lockb",
]);
const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Pipfile.lock",
  "poetry.lock", "uv.lock", "Cargo.lock", "Gemfile.lock", "composer.lock", "go.sum",
  ".DS_Store", "Thumbs.db",
]);
export const MAX_FILE_BYTES = 500_000;
export const MAX_FILES = 1_500;
export const MAX_TOTAL_BYTES = 10_000_000;

/**
 * Files that hold secrets. The consent notice promises we never read credentials,
 * so these are skipped even when they sit in the workspace. Templates like
 * .env.example are fine to send.
 */
export function isSecretFile(name: string): boolean {
  const n = name.toLowerCase();
  if (/^\.env(\..+)?$/.test(n)) return !/\.(example|sample|template|dist)$/.test(n);
  return (
    /\.(pem|key|p12|pfx|keystore|jks)$/.test(n) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(n) ||
    n === ".npmrc" || n === ".pypirc" || n === ".netrc" || n === "credentials.json" ||
    n === "service-account.json" || n === ".git-credentials"
  );
}

export interface CollectedFile {
  path: string;
  content: string;
}

export interface CollectResult {
  files: CollectedFile[];
  /** Secret files we deliberately left out (shown to the user). */
  secrets: string[];
  /** Files over MAX_FILE_BYTES. */
  tooLarge: string[];
  /** Files left out because the file-count or total-size cap was reached. */
  overCap: number;
}

/** Why a workspace-relative path is skipped, or null if it should be read. */
export function skipReason(relPath: string): "dir" | "ext" | "file" | "secret" | null {
  const parts = relPath.split("/");
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return "dir";
  if (SKIP_FILES.has(name)) return "file";
  if (isSecretFile(name)) return "secret";
  const dot = name.lastIndexOf(".");
  if (dot > 0 && SKIP_EXTENSIONS.has(name.slice(dot).toLowerCase())) return "ext";
  return null;
}

/**
 * Candidate paths: git's view when the workspace is a repo (so .gitignore is
 * respected), else a directory walk. Always workspace-relative with "/".
 */
async function listCandidates(workspacePath: string): Promise<string[]> {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: workspacePath,
      encoding: "utf-8",
      maxBuffer: 50_000_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths = [...new Set(out.split("\0").filter(Boolean))];
    if (paths.length > 0) return paths.sort();
  } catch {
    // not a git repo, or git missing: walk instead
  }

  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        found.push(relative(workspacePath, join(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  }
  await walk(workspacePath);
  return found.sort();
}

/** Read the workspace's code for submission, skipping dependencies, binaries and secrets. */
export async function collectWorkspaceFiles(workspacePath: string): Promise<CollectResult> {
  const result: CollectResult = { files: [], secrets: [], tooLarge: [], overCap: 0 };
  let total = 0;

  for (const relPath of await listCandidates(workspacePath)) {
    const reason = skipReason(relPath);
    if (reason === "secret") {
      result.secrets.push(relPath);
      continue;
    }
    if (reason) continue;

    const fullPath = join(workspacePath, relPath);
    let size: number;
    try {
      const s = await stat(fullPath);
      if (!s.isFile()) continue;
      size = s.size;
    } catch {
      continue; // deleted since git listed it
    }
    if (size > MAX_FILE_BYTES) {
      result.tooLarge.push(relPath);
      continue;
    }
    if (result.files.length >= MAX_FILES || total + size > MAX_TOTAL_BYTES) {
      result.overCap++;
      continue;
    }

    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue; // binary
    result.files.push({ path: relPath, content });
    total += size;
  }
  return result;
}

/** "src (8), tests (7), 5 top-level files": where the collected files live. */
export function summarizeFiles(files: CollectedFile[]): string {
  const dirs = new Map<string, number>();
  let topLevel = 0;
  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash === -1) topLevel++;
    else dirs.set(f.path.slice(0, slash), (dirs.get(f.path.slice(0, slash)) ?? 0) + 1);
  }
  const parts = [...dirs.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}/ (${n})`);
  if (topLevel) parts.push(`${topLevel} top-level file${topLevel === 1 ? "" : "s"}`);
  return parts.join(", ");
}

const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|rb|php|cs|cpp|cc|c|h|swift|scala|ex|exs|dart|lua|sql|vue|svelte|zig)$/i;

/** Count of files that look like code (for the "did you write anything?" warning). */
export function countSourceFiles(files: CollectedFile[]): number {
  return files.filter((f) => SOURCE_EXT.test(f.path)).length;
}
