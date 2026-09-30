import { apiRequest, ApiError, resolveApiUrl, type RequestOptions } from "./api.js";
import { ensureAuth, getStoredToken, resolveWebUrl } from "./auth.js";

/**
 * Shared plumbing for the platform commands (challenges, leaderboard, profile...):
 * where the API and web app are, and a GET/POST that sends the stored sign-in.
 */
export interface Ctx {
  baseUrl: string;
  webUrl: string;
  json: boolean;
  /** Stored token or null. Public reads send it when present, for "you" markers. */
  token: string | null;
}

export interface CtxOptions {
  apiUrl?: string;
  json?: boolean;
}

export async function publicCtx(opts: CtxOptions): Promise<Ctx> {
  const baseUrl = resolveApiUrl(opts.apiUrl);
  return { baseUrl, webUrl: resolveWebUrl(baseUrl), json: !!opts.json, token: await getStoredToken() };
}

/** For commands about "you": signs in through the browser if needed. */
export async function authedCtx(opts: CtxOptions): Promise<Ctx & { token: string }> {
  const baseUrl = resolveApiUrl(opts.apiUrl);
  const token = await ensureAuth(baseUrl);
  return { baseUrl, webUrl: resolveWebUrl(baseUrl), json: !!opts.json, token };
}

export function get<T = any>(ctx: Ctx, path: string, opts: Omit<RequestOptions, "token"> = {}): Promise<T> {
  return apiRequest<T>(ctx.baseUrl, path, { token: ctx.token, timeoutMs: 20_000, ...opts });
}

export function send<T = any>(ctx: Ctx, method: string, path: string, body?: unknown, opts: Omit<RequestOptions, "token" | "method" | "body"> = {}): Promise<T> {
  return apiRequest<T>(ctx.baseUrl, path, { token: ctx.token, method, body, retries: 0, timeoutMs: 30_000, ...opts });
}

/** A read that's allowed to fail (optional panel): null instead of an error. */
export async function maybe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/** A read that needs a signed-in user but where signed-out should degrade, not fail. */
export async function whenSignedIn<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T | null> {
  if (!ctx.token) return null;
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

export function query(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Positive integer flag, or the default. Throws a readable error for junk. */
export function intFlag(name: string, value: string | undefined, def: number, min = 1, max = 100): number {
  if (value === undefined) return def;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || String(n) !== value.trim() || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

export function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase() as T;
  if (!allowed.includes(v)) throw new Error(`${name} must be one of: ${allowed.join(", ")}.`);
  return v;
}
