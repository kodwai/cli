import { display } from "../utils/display.js";
import { ensureAuth } from "../utils/auth.js";
import { apiRequest, resolveApiUrl } from "../utils/api.js";
import { findSubmissionMeta } from "../utils/challenge-meta.js";
import { confirm, isInteractive } from "../utils/prompt.js";

/**
 * Stop the challenge in progress without submitting it, so another can start.
 * Local files are left alone. Nothing is scored and no free submission is used.
 */
export async function abandon(apiUrl?: string, yes = false): Promise<void> {
  const found = await findSubmissionMeta(process.cwd());
  const baseUrl = found?.meta.api_url || resolveApiUrl(apiUrl);
  const token = await ensureAuth(baseUrl);

  const active = await apiRequest<{ id: string; challenge_title?: string; challenge_slug?: string } | null>(
    baseUrl,
    "/api/submissions/active",
    { token },
  );
  console.log("");
  if (!active) {
    display.info("  No challenge in progress, nothing to abandon.");
    console.log("");
    return;
  }
  const title = active.challenge_title || active.challenge_slug || "this challenge";
  if (!yes) {
    if (!isInteractive()) throw new Error("Run `kodwai abandon --yes` to confirm without a terminal prompt.");
    const ok = await confirm(`  Abandon "${title}"? It won't be scored, and you can start another. (y/N) `);
    if (!ok) {
      display.info("  Kept it.");
      console.log("");
      return;
    }
  }
  await apiRequest(baseUrl, `/api/submissions/${active.id}`, { method: "DELETE", token, retries: 1 });
  display.success(`Abandoned "${title}". Your local files are untouched.`);
  console.log("");
}
