import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import chalk from "chalk";

// Inlined at build time by tsup (see tsup.config.ts). Falls back to "0.0.0"
// when running uncompiled (e.g. tests), which simply disables the notice.
declare const __CLI_VERSION__: string;
export const CLI_VERSION = typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "0.0.0";

const PKG = "@kodwai/cli";
const CONFIG_DIR = join(homedir(), ".kodwai");
const CACHE_FILE = join(CONFIG_DIR, "update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 4000;

interface UpdateCache {
  lastCheck: number;
  latest: string;
}

/** Honor the de-facto opt-out conventions used by npm/update-notifier. */
function notifierDisabled(): boolean {
  return Boolean(process.env.NO_UPDATE_NOTIFIER || process.env.CI || process.env.KODWAI_NO_UPDATE_NOTIFIER);
}

/** Compare two x.y.z versions (prerelease tags ignored). */
function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function readCache(): Promise<UpdateCache | null> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf-8")) as UpdateCache;
  } catch {
    return null;
  }
}

/**
 * Hidden background entrypoint: hit the npm registry for the latest version and
 * cache it. Runs in a detached child process so it never delays a command.
 */
export async function runUpdateCheck(): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(`https://registry.npmjs.org/${PKG}/latest`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(t);
    if (!resp.ok) return;
    const data = (await resp.json()) as { version?: string };
    if (typeof data.version !== "string") return;
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ lastCheck: Date.now(), latest: data.version }), "utf-8");
  } catch {
    // network/parse errors are non-fatal — we just skip this cycle
  }
}

/** Print a one-line update notice (from cache, instant) when a newer version exists. */
export async function notifyIfOutdated(): Promise<void> {
  if (notifierDisabled() || !process.stdout.isTTY) return;
  const cache = await readCache();
  if (!cache?.latest || !semverGt(cache.latest, CLI_VERSION)) return;

  const rust = chalk.hex("#c23616");
  const l1 = `Update available: ${CLI_VERSION} → ${cache.latest}`;
  const l2 = `Run: npm i -g @kodwai/cli@latest`;
  const w = Math.max(l1.length, l2.length);
  const pad = (s: string) => `│ ${s}${" ".repeat(w - s.length)} │`;
  console.error("");
  console.error(rust(`  ┌${"─".repeat(w + 2)}┐`));
  console.error(rust(`  ${pad(l1)}`));
  console.error(rust(`  ${pad(l2)}`));
  console.error(rust(`  └${"─".repeat(w + 2)}┘`));
  console.error("");
}

/**
 * If the cached check is stale, spawn a detached background process to refresh
 * it for next time. Fully non-blocking: the parent does not wait on the child.
 */
export async function maybeScheduleCheck(binPath: string): Promise<void> {
  if (notifierDisabled()) return;
  const cache = await readCache();
  if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) return;
  try {
    const child = spawn(process.execPath, [binPath, "__update-check"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore — best effort
  }
}
