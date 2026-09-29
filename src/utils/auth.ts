import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { openBrowser } from "./browser.js";
import { ApiError, apiRequest } from "./api.js";

const CONFIG_DIR = join(homedir(), ".kodwai");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const DEFAULT_WEB_URL = "https://app.kodwai.com";

/**
 * Resolve the web app URL for the browser login flow.
 * Precedence: explicit flag > KODWAI_WEB_URL env > derived from the API host.
 * A local API (localhost/127.0.0.1) maps to http://localhost:3000, and
 * api.<domain> maps to app.<domain> (e.g. api.kodwai.com -> app.kodwai.com).
 */
export function resolveWebUrl(apiUrl: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.KODWAI_WEB_URL) return process.env.KODWAI_WEB_URL;
  try {
    const u = new URL(apiUrl);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return `${u.protocol}//localhost:3000`;
    }
    if (u.hostname.startsWith("api.")) {
      return `${u.protocol}//app.${u.hostname.slice(4)}`;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_WEB_URL;
}

interface StoredConfig {
  token?: string;
  api_url?: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  username?: string;
  user_type?: string;
  // Free-submission entitlement (present on /auth/me responses).
  has_claude_api_key?: boolean;
  can_submit?: boolean;
  free_submissions_used?: number;
  free_submissions_limit?: number;
  free_submissions_remaining?: number;
}

async function readConfig(): Promise<StoredConfig> {
  try {
    const data = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeConfig(config: StoredConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // The file holds a bearer token: owner-only, and re-tightened if it already existed.
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600).catch(() => {});
}

export async function getStoredToken(): Promise<string | null> {
  const config = await readConfig();
  return config.token || null;
}

/** Remove the stored token (sign out). Keeps any other config (e.g. api_url). */
export async function clearToken(): Promise<void> {
  const config = await readConfig();
  delete config.token;
  await writeConfig(config);
}

/** Fetch the current user from the API using the stored token, or null (signed out, or unreachable). */
export async function getCurrentUser(baseUrl: string): Promise<AuthUser | null> {
  try {
    return await fetchMe(baseUrl);
  } catch {
    return null;
  }
}

/**
 * The signed-in user, null when there is no valid sign-in (no token, or the API
 * says 401/403). Throws ApiError when the API can't be reached, so callers can
 * say "you're offline" instead of "you're signed out".
 */
export async function fetchMe(baseUrl: string): Promise<AuthUser | null> {
  const token = await getStoredToken();
  if (!token) return null;
  try {
    return await apiRequest<AuthUser>(baseUrl, "/api/auth/me", { token, timeoutMs: 15_000, retries: 1 });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

function resultPage(title: string, message: string, ok: boolean): string {
  const accent = ok ? "#1a7f4b" : "#c23616";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kodwai CLI</title>
<style>body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#faf8f4;color:#1a1a1a;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:420px;text-align:center;padding:40px;border:1px solid #e4e0d8;border-left:3px solid ${accent};background:#fff}
h1{font-size:20px;margin:0 0 12px}p{color:#6b665e;font-size:14px;line-height:1.5}</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Industry-standard browser (OAuth loopback) login: start a local server on an
 * ephemeral port, open the browser to the web approval page, receive a one-time
 * code on the loopback redirect, then exchange it for an access token.
 */
export async function loginWithBrowser(
  baseUrl: string,
  webUrl: string,
): Promise<{ token: string; user: AuthUser }> {
  const state = randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;

    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const finish = (status: number, html: string) => {
        res.writeHead(status, { "Content-Type": "text/html" });
        res.end(html);
        clearTimeout(timeout);
        server.close();
      };

      const code = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");
      if (!code || returnedState !== state) {
        finish(400, resultPage("Sign-in failed", "Invalid or missing authorization. Please run kodwai login again.", false));
        if (!settled) { settled = true; reject(new Error("Authorization failed (state mismatch or missing code).")); }
        return;
      }

      try {
        const tokenResp = await fetch(`${baseUrl}/api/auth/cli/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!tokenResp.ok) {
          const err = await tokenResp.json().catch(() => ({ detail: "Token exchange failed" }));
          finish(400, resultPage("Sign-in failed", String(err.detail || "Token exchange failed"), false));
          if (!settled) { settled = true; reject(new Error(err.detail || "Token exchange failed")); }
          return;
        }
        const data = await tokenResp.json();
        await writeConfig({ token: data.access_token, api_url: baseUrl });
        finish(200, resultPage("You're signed in", "Authentication complete. You can close this tab and return to your terminal.", true));
        if (!settled) { settled = true; resolve({ token: data.access_token, user: data.user as AuthUser }); }
      } catch (e) {
        finish(500, resultPage("Sign-in failed", "Unexpected error during sign-in. Please try again.", false));
        if (!settled) { settled = true; reject(e instanceof Error ? e : new Error("Sign-in failed")); }
      }
    });

    server.on("error", (e) => {
      if (!settled) { settled = true; reject(e); }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = `${webUrl}/auth/cli?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      console.log("\n  Opening your browser to sign in to kodwai...");
      console.log("  If it doesn't open automatically, visit this URL:\n");
      console.log(`  ${authUrl}\n`);
      openBrowser(authUrl);
    });

    // Give the user up to 5 minutes to complete the browser flow.
    timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("Login timed out. Please run `kodwai login` again."));
      }
    }, 5 * 60 * 1000);
  });
}

export async function ensureAuth(baseUrl: string, webUrl?: string): Promise<string> {
  // Reuse the stored token while the API still accepts it. A network failure is
  // reported as such; only a rejected token sends the user to the browser.
  const stored = await getStoredToken();
  if (stored && (await fetchMe(baseUrl))) return stored;

  if (stored) console.log("\n  Your sign-in has expired. Signing you in again...");
  const { token } = await loginWithBrowser(baseUrl, resolveWebUrl(baseUrl, webUrl));
  console.log("  Signed in successfully!\n");
  return token;
}
