/**
 * Encode a workspace path to match Claude Code's directory naming convention.
 *
 * Claude Code stores sessions under:
 *   ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 *
 * It replaces every character that isn't an ASCII letter or digit with a dash,
 * so separators, the Windows drive colon, dots, underscores and spaces all
 * become "-", e.g.:
 *   /Users/joe/myproject        → -Users-joe-myproject      (macOS/Linux)
 *   C:\Users\joe\myproject      → C--Users-joe-myproject     (Windows)
 *   /Users/joe.doe/.work/my_app → -Users-joe-doe--work-my-app
 */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}
