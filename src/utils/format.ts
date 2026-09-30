import chalk from "chalk";

/** Plain-text table: columns padded to the widest cell, right-aligned where asked. Colors are measured without ANSI codes. */
export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: "left" | "right";
  /** Cut longer cells to this many characters (with "…"). */
  max?: number;
}

const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI, "").length;
}

function truncate(s: string, max?: number): string {
  if (!max || visibleLength(s) <= max) return s;
  return s.replace(ANSI, "").slice(0, Math.max(1, max - 1)) + "…";
}

export function table<T>(rows: T[], columns: Column<T>[], indent = "  "): string {
  const cells = rows.map((row) => columns.map((c) => truncate(c.value(row) ?? "", c.max)));
  const widths = columns.map((c, i) => Math.max(visibleLength(c.header), ...cells.map((r) => visibleLength(r[i]))));
  const pad = (s: string, i: number) => {
    const gap = " ".repeat(Math.max(0, widths[i] - visibleLength(s)));
    return columns[i].align === "right" ? gap + s : s + gap;
  };
  const header = indent + columns.map((c, i) => chalk.dim(pad(c.header, i))).join("  ");
  const body = cells.map((r) => indent + r.map((s, i) => pad(s, i)).join("  ").trimEnd());
  return [header, ...body].join("\n");
}

/** One decimal, or "–" when missing. */
export function num(n: number | null | undefined, digits = 1): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "–";
}

/** Whole number, or "–". */
export function int(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(Math.round(n)) : "–";
}

/** A 0..1 ratio as a bar of `width` cells. */
export function bar(ratio: number, width = 20): string {
  const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return "█".repeat(Math.round(r * width)).padEnd(width, "·");
}

/** "3d 4h", "2h 10m", "12m" until (or since, when negative) an ISO time. */
export function countdown(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return "–";
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Next 00:00 UTC, for the daily reset. */
export function nextUtcMidnight(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

/** "2026-09-30" from an ISO time. */
export function day(iso: string | null | undefined): string {
  return iso ? String(iso).slice(0, 10) : "–";
}

/** Minutes from milliseconds. */
export function minutes(ms: number | null | undefined): string {
  return typeof ms === "number" && ms > 0 ? `${Math.max(1, Math.round(ms / 60_000))}m` : "–";
}

export function heading(text: string): void {
  console.log("");
  console.log("  " + chalk.bold(text));
}

export function line(label: string, value: string, width = 14): void {
  console.log(`  ${chalk.dim(label.padEnd(width))}${value}`);
}

export function blank(): void {
  console.log("");
}

/** --json: print the data and nothing else, so agents and scripts can parse it. */
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export const AXIS_LABELS: Record<string, string> = {
  direction: "Direction",
  outcome: "Outcome",
  lift: "Lift",
  challenge_rubric: "Challenge rubric",
};

export const AGENTS = ["claude-code", "cursor", "codex"] as const;

/** One-letter axis tags for compact rows: D/O/L, R for a challenge's own rubric. */
export const AXIS_SHORT: Record<string, string> = { direction: "D", outcome: "O", lift: "L", challenge_rubric: "R" };

/** Signal weights are relative within an axis: show each as its share of the axis. */
export function weightShares(weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + (Number.isFinite(w) && w > 0 ? w : 0), 0);
  return weights.map((w) => (total > 0 && w > 0 ? (w / total) * 100 : 0));
}

/** Mark for "this is you" in a board row. */
export function you(isMe: boolean): string {
  return isMe ? chalk.bold(" ◀ you") : "";
}
