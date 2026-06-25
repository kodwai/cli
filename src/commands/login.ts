import { display } from "../utils/display.js";
import { loginWithBrowser, resolveWebUrl } from "../utils/auth.js";

const DEFAULT_API_URL = "https://api.kodwai.com";

/**
 * Sign in via the browser (OAuth loopback flow). Always runs the browser flow,
 * so it doubles as "switch account": whoever you approve in the browser becomes
 * the signed-in CLI account.
 */
export async function login(apiUrl?: string, webUrl?: string): Promise<void> {
  const baseUrl = apiUrl || process.env.KODWAI_API_URL || DEFAULT_API_URL;
  const web = resolveWebUrl(baseUrl, webUrl);

  display.banner();
  const { user } = await loginWithBrowser(baseUrl, web);
  display.success(`Signed in as ${user?.email ?? "your account"}.`);
  console.log("");
}
