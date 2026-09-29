import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import chalk from "chalk";

// Inlined at build time by tsup (see tsup.config.ts). Falls back to "0.0.0"
// when running uncompiled (e.g. tests), which disables update checks.
declare const __CLI_VERSION__: string;
export const CLI_VERSION = typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "0.0.0";

const PKG = "@kodwai/cli";
const CONFIG_DIR = join(homedir(), ".kodwai");
const CACHE_FILE = join(CONFIG_DIR, "update-check.json");
// How long a registry answer is trusted before we ask npm again on launch.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Launch waits at most this long for npm; after that it uses the cache.
const LAUNCH_FETCH_TIMEOUT_MS = 1500;
const BACKGROUND_FETCH_TIMEOUT_MS = 4000;
// Set on the re-launched process so an update can never loop.
const SKIP_ENV = "KODWAI_JUST_UPDATED";

interface UpdateCache {
  lastCheck: number;
  latest: string;
}

/** Honor the de-facto opt-out conventions used by npm/update-notifier. */
function checksDisabled(): boolean {
  return Boolean(
    process.env.NO_UPDATE_NOTIFIER || process.env.CI || process.env.KODWAI_NO_UPDATE_NOTIFIER ||
      process.env[SKIP_ENV] || CLI_VERSION === "0.0.0",
  );
}

/** Compare two x.y.z versions (prerelease tags ignored). */
export function semverGt(a: string, b: string): boolean {
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

/** Ask the npm registry for the latest version and cache it. Null on any failure. */
async function fetchLatest(timeoutMs: number): Promise<string | null> {
  try {
    const resp = await fetch(`https://registry.npmjs.org/${PKG}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: string };
    if (typeof data.version !== "string") return null;
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ lastCheck: Date.now(), latest: data.version }), "utf-8");
    return data.version;
  } catch {
    return null;
  }
}

/** Hidden background entrypoint kept for older installs that still spawn it. */
export async function runUpdateCheck(): Promise<void> {
  await fetchLatest(BACKGROUND_FETCH_TIMEOUT_MS);
}

/** The newest published version if it's newer than this one, else null. */
async function newerVersion(force: boolean): Promise<string | null> {
  if (!force && checksDisabled()) return null;
  if (CLI_VERSION === "0.0.0") return null;
  const cache = await readCache();
  let latest = cache?.latest ?? null;
  if (force || !cache || Date.now() - cache.lastCheck > CHECK_INTERVAL_MS) {
    latest = (await fetchLatest(LAUNCH_FETCH_TIMEOUT_MS)) ?? latest;
  }
  return latest && semverGt(latest, CLI_VERSION) ? latest : null;
}

type Installer = { kind: "npx" } | { kind: "global"; cmd: string; args: string[]; display: string } | { kind: "unknown" };

/** How this copy of the CLI was installed, judged from where it runs from. */
export function detectInstaller(binPath: string, env: NodeJS.ProcessEnv = process.env): Installer {
  const p = binPath.replace(/\\/g, "/");
  if (p.includes("/_npx/") || env.npm_command === "exec") return { kind: "npx" };
  if (p.includes("/.bun/")) return { kind: "global", cmd: "bun", args: ["add", "-g", `${PKG}@latest`], display: `bun add -g ${PKG}@latest` };
  if (p.includes("/pnpm/") || p.includes("/.pnpm/")) {
    return { kind: "global", cmd: "pnpm", args: ["add", "-g", `${PKG}@latest`], display: `pnpm add -g ${PKG}@latest` };
  }
  if (p.includes("/node_modules/")) {
    return { kind: "global", cmd: "npm", args: ["install", "-g", `${PKG}@latest`], display: `npm i -g ${PKG}@latest` };
  }
  return { kind: "unknown" };
}

function box(lines: string[]): void {
  const rust = chalk.hex("#c23616");
  const w = Math.max(...lines.map((l) => l.length));
  console.error("");
  console.error(rust(`  ┌${"─".repeat(w + 2)}┐`));
  for (const l of lines) console.error(rust(`  │ ${l}${" ".repeat(w - l.length)} │`));
  console.error(rust(`  └${"─".repeat(w + 2)}┘`));
  console.error("");
}

async function askYesDefault(question: string): Promise<boolean> {
  const { confirm } = await import("./prompt.js");
  return confirm(question, true);
}

/** Run the same command again on the freshly installed CLI, then exit with its code. */
function relaunch(cmd: string, args: string[]): never {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, [SKIP_ENV]: "1" },
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 1);
}

/**
 * On launch: when a newer CLI is published, offer to install it and re-run the
 * command on it. `force` (the API refused this version) skips the opt-outs and
 * the cache. Returns normally when we keep running the current version.
 */
export async function offerUpdate(binPath: string, argv: string[], force = false): Promise<void> {
  const latest = await newerVersion(force);
  if (!latest) return;

  const installer = detectInstaller(binPath);
  const how =
    installer.kind === "npx" ? `npx ${PKG}@latest ${argv.join(" ")}`.trim()
      : installer.kind === "global" ? installer.display
        : `npm i -g ${PKG}@latest`;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (!interactive || installer.kind === "unknown") {
    box([`Update available: ${CLI_VERSION} → ${latest}`, `Run: ${how}`]);
    return;
  }

  box([`kodwai ${latest} is out (you have ${CLI_VERSION}).`, "Updates fix scoring and upload bugs."]);
  if (!(await askYesDefault("  Update now? (Y/n) "))) {
    console.error(`  Skipped. Update anytime with: ${how}\n`);
    return;
  }

  if (installer.kind === "npx") {
    relaunch("npx", ["-y", `${PKG}@latest`, ...argv]);
  }
  console.error(`\n  Running: ${installer.display}\n`);
  const install = spawnSync(installer.cmd, installer.args, { stdio: "inherit", shell: process.platform === "win32" });
  if (install.status !== 0) {
    const sudo = process.platform !== "win32" && installer.cmd === "npm" ? `sudo ${installer.display}` : installer.display;
    console.error(`\n  The update didn't install. Try: ${sudo}`);
    console.error(`  Continuing on ${CLI_VERSION} for now.\n`);
    return;
  }
  console.error("\n  Update installed. Re-running your command...\n");
  relaunch(process.execPath, [binPath, ...argv]);
}

/** Kept for compatibility: refresh the cache in a detached process (no prompt). */
export async function maybeScheduleCheck(binPath: string): Promise<void> {
  if (checksDisabled()) return;
  const cache = await readCache();
  if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) return;
  try {
    const child = spawn(process.execPath, [binPath, "__update-check"], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best effort
  }
}
