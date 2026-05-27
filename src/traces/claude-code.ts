import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentTrace, TraceTurn } from "./types.js";
import { rateTraceQuality } from "./quality.js";

/**
 * Collect Claude Code traces scoped to a specific workspace.
 *
 * Claude Code stores sessions under:
 *   ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 *
 * The encoded path replaces "/" with "-", e.g.:
 *   /Users/joe/myproject → -Users-joe-myproject
 *
 * Each JSONL line has: type ("user"|"assistant"|"system"), message, sessionId, cwd, timestamp
 */
export async function collectClaudeCodeTrace(
  startTime: Date,
  workspacePath: string,
): Promise<AgentTrace | null> {
  const claudeProjectsDir = join(homedir(), ".claude", "projects");

  // Encode workspace path to match Claude Code's directory naming
  const encodedPath = workspacePath.replace(/\//g, "-");

  // Find matching project directories (exact match or subdirectory match)
  let projectDirs: string[] = [];
  try {
    const allDirs = await readdir(claudeProjectsDir, { withFileTypes: true });
    for (const entry of allDirs) {
      if (entry.isDirectory() && entry.name === encodedPath) {
        projectDirs.push(join(claudeProjectsDir, entry.name));
      }
    }
  } catch {
    return null; // No ~/.claude/projects/ directory
  }

  if (projectDirs.length === 0) {
    // Try partial match — the workspace may be a subdirectory
    try {
      const allDirs = await readdir(claudeProjectsDir, { withFileTypes: true });
      for (const entry of allDirs) {
        if (entry.isDirectory() && entry.name.endsWith(encodedPath.split("-").slice(-3).join("-"))) {
          projectDirs.push(join(claudeProjectsDir, entry.name));
        }
      }
    } catch {
      return null;
    }
  }

  if (projectDirs.length === 0) return null;

  const turns: TraceTurn[] = [];

  for (const projectDir of projectDirs) {
    // Read all JSONL session files modified after startTime
    try {
      const entries = await readdir(projectDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

        const filePath = join(projectDir, entry.name);
        try {
          const s = await stat(filePath);
          if (s.mtime < startTime) continue; // Skip old sessions
        } catch {
          continue;
        }

        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n").filter((l) => l.trim());

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);

              // Filter by timestamp — only include messages after startTime
              if (entry.timestamp) {
                const msgTime = new Date(entry.timestamp);
                if (msgTime < startTime) continue;
              }

              if (entry.type === "user") {
                const msg = entry.message;
                if (!msg?.content) continue;
                // Content can be string or array of content blocks
                const text = extractText(msg.content);
                if (text) {
                  turns.push({ role: "user", content: text.slice(0, 2000), timestamp: entry.timestamp });
                }
              } else if (entry.type === "assistant") {
                const msg = entry.message;
                if (!msg?.content) continue;
                const text = extractText(msg.content);
                const toolCalls = extractToolCalls(msg.content);
                if (text || toolCalls) {
                  turns.push({
                    role: "assistant",
                    content: (text || "[tool use only]").slice(0, 2000),
                    timestamp: entry.timestamp,
                    tool_calls: toolCalls,
                  });
                }
              }
            } catch {
              // Skip unparseable lines
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      continue;
    }
  }

  if (turns.length === 0) return null;

  return {
    agent: "claude-code",
    turns,
    trace_quality: rateTraceQuality(turns),
  };
}

/**
 * Extract text from Anthropic API message content (string or content blocks array).
 */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text || "")
    .join("\n")
    .trim();
}

/**
 * Extract tool calls from content blocks.
 */
function extractToolCalls(content: any): { name: string; input: string; output: string }[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const calls = content
    .filter((block: any) => block.type === "tool_use")
    .map((block: any) => ({
      name: block.name || "unknown",
      input: (typeof block.input === "string" ? block.input : JSON.stringify(block.input || "")).slice(0, 500),
      output: "", // Output comes in subsequent tool_result messages
    }));

  return calls.length > 0 ? calls : undefined;
}
