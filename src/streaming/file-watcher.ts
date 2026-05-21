import { readFile, readdir, stat } from "node:fs/promises";
import { relative, join } from "node:path";
import { createHmac } from "node:crypto";

interface FileWatcher {
  stop(): void;
}

// Directories to always ignore
const IGNORE_DIRS = new Set([
  "node_modules", ".next", ".nuxt", ".output", "dist", "build",
  ".turbo", ".cache", ".parcel-cache",
  "__pycache__", ".venv", "venv", "env", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "vendor", "target", ".gradle", ".m2", ".bundle",
  ".git", ".svn", ".hg", ".claude", ".idea", ".vscode",
  "coverage", ".nyc_output",
]);

// File extensions to ignore (binaries, media, large generated files)
const IGNORE_EXTENSIONS = new Set([
  ".pyc", ".pyo", ".class", ".o", ".obj", ".so", ".dylib", ".dll",
  ".exe", ".bin", ".wasm",
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".tiff", ".tif", ".avif",
  ".svg",
  ".mp4", ".mp3", ".wav", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz",
  ".ttf", ".woff", ".woff2", ".eot", ".otf",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".db", ".sqlite", ".sqlite3",
  ".map",
]);

// Specific files to ignore
const IGNORE_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "Pipfile.lock", "poetry.lock", "go.sum", "Cargo.lock",
  "Gemfile.lock", "composer.lock",
  ".DS_Store", "Thumbs.db",
]);

function shouldIgnore(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const fileName = parts[parts.length - 1];

  for (const part of parts) {
    if (IGNORE_DIRS.has(part)) return true;
  }

  const ext = fileName.lastIndexOf(".") >= 0 ? fileName.slice(fileName.lastIndexOf(".")) : "";
  if (IGNORE_EXTENSIONS.has(ext)) return true;
  if (IGNORE_FILES.has(fileName)) return true;

  return false;
}

export function createFileWatcher(
  workspacePath: string,
  sessionId: string,
  webhookSecret: string,
  baseUrl: string,
): FileWatcher {
  // Track all files we've already sent so we don't duplicate
  const sentFiles = new Map<string, number>(); // relativePath -> last modified time
  let scanInterval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function sign(body: string): string {
    const sig = createHmac("sha256", webhookSecret).update(body).digest("hex");
    return `sha256=${sig}`;
  }

  async function sendFileChange(relativePath: string, content: string, changeType: "create" | "update"): Promise<void> {
    const payload = {
      file_path: relativePath.replace(/\\/g, "/"),
      content,
      change_type: changeType,
      timestamp: new Date().toISOString(),
    };

    const body = JSON.stringify(payload);
    try {
      await fetch(`${baseUrl}/api/sessions/${sessionId}/files`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kodwai-Signature": sign(body),
          "X-Kodwai-Session": sessionId,
        },
        body,
      });
    } catch {
      // Don't crash on network errors
    }
  }

  /**
   * Recursively scan the workspace directory and send any new or modified files.
   * This catches files that chokidar misses (bulk creation, race conditions).
   */
  async function scanDirectory(dir: string): Promise<void> {
    if (stopped) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (stopped) return;

      const fullPath = join(dir, entry.name);
      const relativePath = relative(workspacePath, fullPath);

      if (shouldIgnore(relativePath)) continue;

      if (entry.isDirectory()) {
        await scanDirectory(fullPath);
      } else if (entry.isFile()) {
        try {
          const stats = await stat(fullPath);
          const mtimeMs = stats.mtimeMs;
          const prevMtime = sentFiles.get(relativePath);

          // Skip if we've already sent this version
          if (prevMtime !== undefined && prevMtime >= mtimeMs) continue;

          // Skip large files (> 500KB)
          if (stats.size > 500_000) continue;

          const content = await readFile(fullPath, "utf-8");
          const changeType = prevMtime === undefined ? "create" : "update";

          sentFiles.set(relativePath, mtimeMs);
          await sendFileChange(relativePath, content, changeType);
        } catch {
          // File may have been deleted or is binary
        }
      }
    }
  }

  function startScanning(): void {
    // Initial scan after a short delay (let workspace setup finish)
    setTimeout(() => {
      if (!stopped) scanDirectory(workspacePath);
    }, 2000);

    // Periodic scan every 3 seconds to catch anything missed
    scanInterval = setInterval(() => {
      if (!stopped) scanDirectory(workspacePath);
    }, 3000);
  }

  function stop(): void {
    stopped = true;
    if (scanInterval) clearInterval(scanInterval);
    // Final scan to catch last changes
    scanDirectory(workspacePath);
  }

  startScanning();

  return { stop };
}
