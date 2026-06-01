import { display } from "../utils/display.js";
import { getCurrentUser } from "../utils/auth.js";

const DEFAULT_API_URL = "https://api.kodwai.com";

/** Print the currently signed-in account. */
export async function whoami(apiUrl?: string): Promise<void> {
  const baseUrl = apiUrl || process.env.KODWAI_API_URL || DEFAULT_API_URL;
  const user = await getCurrentUser(baseUrl);
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
