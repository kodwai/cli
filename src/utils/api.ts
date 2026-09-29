import { CLI_VERSION } from "./update-notifier.js";

export const DEFAULT_API_URL = "https://api.kodwai.com";

/** API base URL: explicit flag > KODWAI_API_URL env > production. Trailing slashes are dropped. */
export function resolveApiUrl(explicit?: string): string {
  return (explicit || process.env.KODWAI_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

/** An API call that failed in a way worth showing the user as-is. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Turn a FastAPI error body into one readable line. `detail` is a string for
 * HTTPException, and a list of {loc, msg} objects for validation errors.
 */
export function errorDetail(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    return detail
      .map((d: any) => {
        const where = Array.isArray(d?.loc) ? d.loc.filter((p: unknown) => p !== "body").join(".") : "";
        return where ? `${where}: ${d?.msg ?? "invalid"}` : String(d?.msg ?? d);
      })
      .join("; ");
  }
  return fallback;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface RequestOptions {
  method?: string;
  token?: string | null;
  body?: unknown;
  /** Per-attempt timeout. Uploads get longer than reads. */
  timeoutMs?: number;
  /** Extra attempts after the first, for network errors and 5xx/429 only. */
  retries?: number;
  /** Used when the server sends no readable `detail`. */
  fallbackError?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function networkMessage(baseUrl: string, err: unknown): string {
  const code = (err as any)?.cause?.code || (err as any)?.code;
  if ((err as any)?.name === "TimeoutError" || (err as any)?.name === "AbortError") {
    return `The kodwai API at ${baseUrl} took too long to answer. Check your connection and try again.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Can't reach ${baseUrl} (DNS lookup failed). Are you online?`;
  }
  if (code === "ECONNREFUSED") {
    return `Can't reach ${baseUrl} (connection refused). If you're using --local, is the API running?`;
  }
  return `Can't reach the kodwai API at ${baseUrl}. Check your connection and try again.`;
}

/**
 * fetch() for the kodwai API: JSON in and out, a timeout on every attempt,
 * retries with backoff on network errors and 429/5xx, and errors that read like
 * sentences instead of "fetch failed". Returns the parsed JSON body (or null for
 * an empty body). Throws ApiError for any non-2xx answer.
 */
export async function apiRequest<T = any>(baseUrl: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", token, body, timeoutMs = 30_000, retries = 2, fallbackError } = opts;
  // The API refuses outdated CLIs on start/submit (HTTP 426) based on this header.
  const headers: Record<string, string> = { Accept: "application/json", "X-Kodwai-CLI-Version": CLI_VERSION };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);

  let lastNetworkError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastNetworkError = err;
      continue;
    }
    if (RETRYABLE_STATUS.has(resp.status) && attempt < retries) continue;

    const text = await resp.text().catch(() => "");
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!resp.ok) {
      const fallback = fallbackError || `Request failed (HTTP ${resp.status})`;
      let message = errorDetail(json, fallback);
      if (resp.status === 401) message = "Your sign-in has expired. Run `kodwai login` and try again.";
      if (resp.status === 426) message = errorDetail(json, "This version of the kodwai CLI is out of date.");
      throw new ApiError(message, resp.status, json?.detail);
    }
    return json as T;
  }
  throw new ApiError(networkMessage(baseUrl, lastNetworkError), 0);
}
