import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";

interface TranscriptWatcher {
  stop(): void;
}

function encodeWorkspacePath(workspacePath: string): string {
  return workspacePath.replace(/[\/\\]/g, "-");
}

async function findLatestTranscript(workspacePath: string): Promise<string | null> {
  const projectsDir = join(homedir(), ".claude", "projects", encodeWorkspacePath(workspacePath));
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }

  let newest: { path: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(projectsDir, name);
    try {
      const s = await stat(full);
      if (!newest || s.mtimeMs > newest.mtime) {
        newest = { path: full, mtime: s.mtimeMs };
      }
    } catch {
      // skip
    }
  }
  return newest ? newest.path : null;
}

function extractAssistantText(entry: any): string | null {
  if (!entry || entry.type !== "assistant" || !entry.message?.content) return null;
  const blocks = entry.message.content;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n\n")
    .trim();
  return text || null;
}

export function createTranscriptWatcher(
  workspacePath: string,
  sessionId: string,
  webhookSecret: string,
  baseUrl: string,
): TranscriptWatcher {
  const sentUuids = new Set<string>();
  let stopped = false;
  let scanning = false;

  function sign(body: string): string {
    return "sha256=" + createHmac("sha256", webhookSecret).update(body).digest("hex");
  }

  async function postAssistantMessage(text: string, uuid: string, timestamp: string): Promise<void> {
    const body = JSON.stringify({
      event_type: "assistant_message",
      data: { text, uuid, source: "transcript-watcher" },
      timestamp,
    });
    try {
      await fetch(`${baseUrl}/api/sessions/${sessionId}/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kodwai-Signature": sign(body),
          "X-Kodwai-Session": sessionId,
        },
        body,
      });
    } catch {
      // best effort; next scan will retry the same UUID since we only mark sent on success
      sentUuids.delete(uuid);
    }
  }

  async function scan(): Promise<void> {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const path = await findLatestTranscript(workspacePath);
      if (!path) return;

      let raw: string;
      try {
        raw = await readFile(path, "utf-8");
      } catch {
        return;
      }

      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      for (const line of lines) {
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const text = extractAssistantText(entry);
        if (!text || !entry.uuid) continue;
        if (sentUuids.has(entry.uuid)) continue;

        // Mark as sent BEFORE await so concurrent scans don't double-send
        sentUuids.add(entry.uuid);
        await postAssistantMessage(text.slice(0, 8000), entry.uuid, entry.timestamp || new Date().toISOString());
      }
    } finally {
      scanning = false;
    }
  }

  // First scan after a short delay (let Claude Code create the JSONL)
  setTimeout(() => { void scan(); }, 1500);

  // Then poll every 1.5s for new entries
  const interval = setInterval(() => { void scan(); }, 1500);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
      // Final scan to catch the final response
      void scan();
    },
  };
}
