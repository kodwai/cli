/**
 * Text that shows up as a "user" turn in an agent transcript but wasn't typed by
 * the user: context the harness injects (environment, AGENTS.md, skill bodies,
 * background task notices, local command output) and kodwai's own plugin
 * commands. Direction is scored from what the user actually said, so these are
 * dropped before upload.
 *
 * Claude Code also marks its injections with `isMeta: true` on the line; that
 * flag is checked in claude-code.ts. This list catches the rest, for every agent.
 */
const INJECTED_WRAPPERS =
  /^<(environment_context|user_instructions|skill|turn_aborted|subagent_notification|recommended_plugins|in-app-browser-context|task-notification|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder)\b/;

const AGENTS_MD = /^# AGENTS\.md instructions\b/;

/** `/kodwai:submit`, `$kodwai:status` or the Claude Code command wrapper for them. */
const KODWAI_COMMAND = /^(?:[/$]kodwai:[a-z-]+\b|<command-(?:name|message)>\/?kodwai:)/;

export function isInjectedUserText(text: string): boolean {
  const t = text.trimStart();
  return INJECTED_WRAPPERS.test(t) || AGENTS_MD.test(t) || KODWAI_COMMAND.test(t);
}
