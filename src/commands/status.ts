import { display } from "../utils/display.js";
import { fetchMe, getStoredToken, resolveWebUrl } from "../utils/auth.js";
import { apiRequest, resolveApiUrl } from "../utils/api.js";
import { collectWorkspaceFiles, countSourceFiles, summarizeFiles } from "../utils/collect.js";
import { elapsed, findSubmissionMeta } from "../utils/challenge-meta.js";
import { printScorecard, type SubmissionView } from "../utils/results.js";

/**
 * Where am I? Inside a workspace: time used/left, files so far, or the score if
 * it's submitted. Anywhere else: the account and any challenge in progress.
 */
export async function status(apiUrl?: string): Promise<void> {
  const found = await findSubmissionMeta(process.cwd());
  console.log("");

  if (found) {
    const { meta, workspacePath } = found;
    const baseUrl = meta.api_url;
    const resultsUrl = `${resolveWebUrl(baseUrl)}/dev/submissions/${meta.submission_id}`;
    display.info(`  Challenge:  ${meta.challenge_title || meta.challenge_slug}`);
    display.info(`  Workspace:  ${workspacePath}`);
    display.info(`  Agent:      ${meta.agent_choice}`);

    if (meta.submitted_at) {
      display.info(`  Submitted:  ${new Date(meta.submitted_at).toLocaleString()}`);
      const token = await getStoredToken();
      if (!token) {
        display.info(`  Results:    ${resultsUrl}`);
        console.log("");
        return;
      }
      try {
        const view = await apiRequest<SubmissionView>(baseUrl, `/api/submissions/${meta.submission_id}`, { token });
        if (view.status === "scored" || view.status === "error") printScorecard(view, resultsUrl);
        else display.info(`  Status:     ${view.status}. Results: ${resultsUrl}\n`);
      } catch (e) {
        display.info(`  Results:    ${resultsUrl}`);
        display.warning((e as Error).message);
        console.log("");
      }
      return;
    }

    const t = elapsed(meta);
    const left = t.limitMinutes - t.minutes;
    display.info(`  Time:       ${t.minutes}/${t.limitMinutes} min` + (t.late ? ` (over by ${-left} min, late penalty applies)` : ` (${left} min left)`));
    const { files } = await collectWorkspaceFiles(workspacePath);
    display.info(`  Files:      ${files.length} (${countSourceFiles(files)} source)${files.length ? `: ${summarizeFiles(files)}` : ""}`);
    console.log("");
    display.info("  Submit with: kodwai submit");
    console.log("");
    return;
  }

  const baseUrl = resolveApiUrl(apiUrl);
  const user = await fetchMe(baseUrl);
  if (!user) {
    display.info("  Not signed in. Run `kodwai login`, or start a challenge with `kodwai challenge <slug>`.");
    console.log("");
    process.exitCode = 1;
    return;
  }
  display.info(`  Signed in as ${user.email}${user.username ? ` (@${user.username})` : ""}`);
  const token = await getStoredToken();
  const active = await apiRequest<{ challenge_title?: string; challenge_slug?: string; started_at: string } | null>(
    baseUrl,
    "/api/submissions/active",
    { token },
  ).catch(() => null);
  if (active) {
    display.info(`  In progress: ${active.challenge_title || active.challenge_slug} (started ${active.started_at} UTC)`);
    display.info("  cd into its kodwai-<slug> folder and run `kodwai submit`, or drop it with `kodwai abandon`.");
  } else {
    display.info("  No challenge in progress. Start one with `kodwai challenge <slug>`.");
  }
  console.log("");
}
