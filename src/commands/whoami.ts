import { display } from "../utils/display.js";
import { resolveApiUrl } from "../utils/api.js";
import { fetchMe } from "../utils/auth.js";

/** Print the currently signed-in account. */
export async function whoami(apiUrl?: string): Promise<void> {
  const baseUrl = resolveApiUrl(apiUrl);
  const user = await fetchMe(baseUrl); // throws a readable error when offline
  console.log("");
  if (!user) {
    display.info("  Not signed in. Run `kodwai login`.");
    console.log("");
    process.exitCode = 1;
    return;
  }
  const handle = user.username ? ` (@${user.username})` : "";
  display.info(`  Signed in as ${user.name} <${user.email}>${handle}`);
  if (user.user_type === "developer" && !user.has_claude_api_key && (user.free_submissions_limit ?? 0) > 0) {
    display.info(`  ${user.free_submissions_remaining ?? 0} of ${user.free_submissions_limit} free submissions left`);
  }
  console.log("");
}
