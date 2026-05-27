import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import type { AgentTrace, TraceTurn } from "./types.js";
import { rateTraceQuality } from "./quality.js";

/**
 * Collect Cursor traces for a specific workspace.
 *
 * Cursor stores data in two SQLite databases:
 *
 * 1. Per-workspace: ~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/state.vscdb
 *    - ItemTable has `composer.composerData` → lists composer IDs for this workspace
 *    - workspace.json maps <hash> → project folder path
 *
 * 2. Global: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *    - cursorDiskKV has `bubbleId:<composerId>:<bubbleId>` → individual messages
 *    - cursorDiskKV has `composerData:<composerId>` → conversation metadata + message order
 */
export async function collectCursorTrace(
  startTime: Date,
  workspacePath: string,
): Promise<AgentTrace | null> {
  const p = platform();
  let cursorBase: string;
  if (p === "darwin") {
    cursorBase = join(homedir(), "Library", "Application Support", "Cursor", "User");
  } else if (p === "linux") {
    cursorBase = join(homedir(), ".config", "Cursor", "User");
  } else {
    const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    cursorBase = join(appdata, "Cursor", "User");
  }

  try {
    await stat(cursorBase);
  } catch {
    return null; // Cursor not installed
  }

  // Step 1: Find the workspace hash that matches our project path
  const composerIds = await findComposerIds(cursorBase, workspacePath);
  if (composerIds.length === 0) {
    // Try parent directories too (user may have opened a parent folder)
    const parentPath = join(workspacePath, "..");
    const parentIds = await findComposerIds(cursorBase, parentPath);
    if (parentIds.length === 0) return null;
    composerIds.push(...parentIds);
  }

  // Step 2: Extract messages from global DB
  const globalDb = join(cursorBase, "globalStorage", "state.vscdb");
  const turns = await extractBubbles(globalDb, composerIds, startTime);

  if (turns.length === 0) return null;

  return {
    agent: "cursor",
    turns,
    trace_quality: rateTraceQuality(turns),
  };
}

/**
 * Find composer IDs for a workspace by scanning workspaceStorage directories.
 */
async function findComposerIds(cursorBase: string, targetPath: string): Promise<string[]> {
  const wsStorage = join(cursorBase, "workspaceStorage");
  const composerIds: string[] = [];

  try {
    const dirs = await readdir(wsStorage, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const wsJsonPath = join(wsStorage, dir.name, "workspace.json");

      try {
        const wsJson = JSON.parse(await readFile(wsJsonPath, "utf-8"));
        // Strip the file:// scheme (on Windows Cursor uses file:///C:/... so stripping
        // "file://" leaves "/C:/..." — we normalise separators on both sides so the
        // startsWith comparison works on Windows too).
        const folderRaw = decodeURIComponent(wsJson.folder || "").replace("file://", "");
        // Normalise both sides to forward-slashes for a consistent comparison.
        const folder = folderRaw.replace(/\\/g, "/");
        const normalTarget = targetPath.replace(/\\/g, "/");

        // Match if the workspace folder is our target or a parent of it
        if (normalTarget.startsWith(folder) || folder.startsWith(normalTarget)) {
          // Read composer IDs from this workspace's state.vscdb
          const dbPath = join(wsStorage, dir.name, "state.vscdb");
          const ids = await getComposerIdsFromDb(dbPath);
          composerIds.push(...ids);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // workspaceStorage not found
  }

  return composerIds;
}

/**
 * Read composer IDs from a workspace's state.vscdb ItemTable.
 */
async function getComposerIdsFromDb(dbPath: string): Promise<string[]> {
  try {
    await stat(dbPath);
  } catch {
    return [];
  }

  try {
    // Use sqlite3 CLI to query (available on macOS by default, avoids npm dependency)
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'composer.composerData'" 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();

    if (!result) return [];
    const data = JSON.parse(result);
    const composers = data.allComposers || [];
    return composers.map((c: any) => c.composerId).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Extract conversation bubbles from the global cursorDiskKV table.
 */
async function extractBubbles(
  globalDbPath: string,
  composerIds: string[],
  startTime: Date,
): Promise<TraceTurn[]> {
  const turns: TraceTurn[] = [];

  try {
    await stat(globalDbPath);
  } catch {
    return turns;
  }

  for (const composerId of composerIds) {
    try {
      // Get conversation order from composerData
      const cdResult = execSync(
        `sqlite3 "${globalDbPath}" "SELECT value FROM cursorDiskKV WHERE key = 'composerData:${composerId}'" 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();

      if (!cdResult) continue;
      const composerData = JSON.parse(cdResult);
      const headers = composerData.fullConversationHeadersOnly || [];

      // Get all bubbles for this composer
      const bubblesResult = execSync(
        `sqlite3 "${globalDbPath}" "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${composerId}:%'" 2>/dev/null`,
        { encoding: "utf-8", timeout: 10000, maxBuffer: 10_000_000 },
      ).trim();

      if (!bubblesResult) continue;

      // Parse bubble data — sqlite3 outputs key|value per line
      const bubbleMap = new Map<string, any>();
      for (const line of bubblesResult.split("\n")) {
        const pipeIdx = line.indexOf("|");
        if (pipeIdx < 0) continue;
        const key = line.slice(0, pipeIdx);
        const val = line.slice(pipeIdx + 1);
        try {
          const bubbleId = key.split(":")[2];
          bubbleMap.set(bubbleId, JSON.parse(val));
        } catch {
          // Skip malformed
        }
      }

      // Process in conversation order
      for (const header of headers) {
        const bubble = bubbleMap.get(header.bubbleId);
        if (!bubble) continue;

        // Filter by time
        const createdAt = bubble.createdAt;
        if (createdAt) {
          const bubbleTime = new Date(createdAt);
          if (bubbleTime < startTime) continue;
        }

        const btype = bubble.type; // 1 = user, 2 = assistant
        const text = bubble.text || "";
        const codeBlocks = bubble.codeBlocks || [];

        if (btype === 1 && text.trim()) {
          turns.push({
            role: "user",
            content: text.slice(0, 2000),
            timestamp: createdAt,
          });
        } else if (btype === 2) {
          let content = text.trim();
          // If no text, check code blocks
          if (!content && codeBlocks.length > 0) {
            content = codeBlocks
              .map((b: any) => `[${b.languageId || "code"}] ${(b.content || "").slice(0, 500)}`)
              .join("\n");
          }

          // Check for tool calls
          const toolData = bubble.toolFormerData;
          const toolCalls = toolData
            ? [
                {
                  name: toolData.toolName || toolData.type || "tool",
                  input: JSON.stringify(toolData.parameters || toolData.input || "").slice(0, 500),
                  output: "",
                },
              ]
            : undefined;

          if (content || toolCalls) {
            turns.push({
              role: "assistant",
              content: (content || "[tool use]").slice(0, 2000),
              timestamp: createdAt,
              tool_calls: toolCalls,
            });
          }
        }
      }
    } catch {
      // Skip this composer
      continue;
    }
  }

  return turns;
}
