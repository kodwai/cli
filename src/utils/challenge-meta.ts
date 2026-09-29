import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentChoice } from "../traces/detector.js";

/** What `kodwai challenge` writes to <workspace>/.kodwai/submission.json. */
export interface SubmissionMeta {
  submission_id: string;
  challenge_id: string;
  challenge_slug: string;
  challenge_title?: string;
  agent_choice: AgentChoice;
  started_at: string;
  workspace_path: string;
  api_url: string;
  time_limit_minutes: number;
  test_suite?: any[];
  /** Set by `kodwai submit` once the API accepted the submission. */
  submitted_at?: string;
}

export interface FoundMeta {
  meta: SubmissionMeta;
  /** The directory that actually holds .kodwai/ right now (the workspace may have been moved). */
  workspacePath: string;
  metaPath: string;
}

/** Walk up from `startDir` to the filesystem root looking for .kodwai/submission.json. */
export async function findSubmissionMeta(startDir: string): Promise<FoundMeta | null> {
  let dir = startDir;
  for (;;) {
    const metaPath = join(dir, ".kodwai", "submission.json");
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf-8")) as SubmissionMeta;
      if (meta && typeof meta.submission_id === "string") {
        return { meta, workspacePath: dir, metaPath };
      }
    } catch {
      // not here (or unreadable); keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function writeSubmissionMeta(metaPath: string, meta: SubmissionMeta): Promise<void> {
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

/** Minutes elapsed since the challenge started, and whether that's past the limit. */
export function elapsed(meta: Pick<SubmissionMeta, "started_at" | "time_limit_minutes">, now = Date.now()) {
  const startedMs = new Date(meta.started_at).getTime();
  const ms = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0;
  const limitMs = (meta.time_limit_minutes || 60) * 60_000;
  return { ms, minutes: Math.round(ms / 60_000), limitMinutes: meta.time_limit_minutes || 60, late: ms > limitMs };
}
