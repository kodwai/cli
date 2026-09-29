import { display } from "../utils/display.js";
import { resolveApiUrl } from "../utils/api.js";
import { loginWithBrowser, resolveWebUrl } from "../utils/auth.js";

/**
 * Sign in via the browser (OAuth loopback flow). Always runs the browser flow,
 * so it doubles as "switch account": whoever you approve in the browser becomes
 * the signed-in CLI account.
 */
export async function login(apiUrl?: string, webUrl?: string): Promise<void> {
  const baseUrl = resolveApiUrl(apiUrl);
  const web = resolveWebUrl(baseUrl, webUrl);

  display.banner();
  const { user } = await loginWithBrowser(baseUrl, web);
  display.success(`Signed in as ${user?.email ?? "your account"}.`);
  console.log("");
}
