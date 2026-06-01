import { display } from "./display.js";
import { getCurrentUser, resolveWebUrl } from "./auth.js";

/**
 * Verify the signed-in developer can still submit challenges — they have free
 * submissions left or a connected Anthropic key. When they can't, prints a
 * warning plus a link to the web app and returns false (the caller should
 * stop). Fails open on a network/auth hiccup since the API enforces the limit
 * server-side regardless, so a transient check failure never blocks a user who
 * is actually allowed.
 */
export async function ensureCanSubmit(baseUrl: string): Promise<boolean> {
  const user = await getCurrentUser(baseUrl);
  if (!user) return true; // not signed in / couldn't check — let auth + server decide
  if (user.user_type && user.user_type !== "developer") return true;
  if (user.can_submit !== false) return true; // true or unknown → allow

  const webUrl = resolveWebUrl(baseUrl);
  console.log("");
  if ((user.free_submissions_limit ?? 0) > 0) {
    display.warning("You've used all your free submissions.");
  } else {
    display.warning("This account needs an Anthropic API key to submit challenges.");
  }
  display.info("");
  display.info("  Connect your Anthropic API key to keep going:");
  display.info(`  ${webUrl}`);
  display.info("");
  return false;
}
