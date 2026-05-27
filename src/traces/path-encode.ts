/**
 * Encode a workspace path to match Claude Code's directory naming convention.
 *
 * Claude Code stores sessions under:
 *   ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 *
 * It encodes the path by replacing path separators and the Windows drive colon
 * with dashes, e.g.:
 *   /Users/joe/myproject   → -Users-joe-myproject   (macOS/Linux)
 *   C:\Users\joe\myproject → C--Users-joe-myproject  (Windows)
 *
 * This helper is cross-platform: on macOS/Linux only "/" is present so the
 * output is identical to the previous `path.replace(/\//g, "-")` behaviour.
 */
export function encodeProjectPath(p: string): string {
  return p.replace(/[/\\:]/g, "-");
}
