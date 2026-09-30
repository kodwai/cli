import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/utils/auth.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    getStoredToken: vi.fn(async () => "tok"),
    ensureAuth: vi.fn(async () => "tok"),
  };
});

import { table, num, countdown, weightShares, visibleLength, nextUtcMidnight } from "../src/utils/format.js";
import { intFlag, oneOf, query } from "../src/utils/context.js";
import { normalizeX } from "../src/commands/me.js";
import { listChallenges } from "../src/commands/browse.js";
import { leaderboard } from "../src/commands/standings.js";
import { claimQuest } from "../src/commands/me.js";
import { setUsername, sendFeedback } from "../src/commands/account.js";

describe("format helpers", () => {
  it("pads columns by visible width, ignoring ANSI color codes", () => {
    const out = table(
      [{ a: "\x1b[32mok\x1b[39m", b: 5 }, { a: "longer", b: 12 }],
      [
        { header: "A", value: (r) => r.a },
        { header: "B", value: (r) => String(r.b), align: "right" },
      ],
    ).split("\n");
    // Every row lines up: same visible width once color codes are ignored.
    expect(new Set(out.map(visibleLength)).size).toBe(1);
    expect(out[1].replace(/\x1b\[[0-9;]*m/g, "")).toBe("  ok       5");
    expect(out[2]).toBe("  longer  12");
  });

  it("formats numbers and missing values", () => {
    expect(num(49.123)).toBe("49.1");
    expect(num(null)).toBe("–");
    expect(num(Number.NaN)).toBe("–");
  });

  it("counts down in d/h/m", () => {
    const now = Date.parse("2026-09-30T10:00:00Z");
    expect(countdown("2026-10-02T13:30:00Z", now)).toBe("2d 3h");
    expect(countdown("2026-09-30T12:15:00Z", now)).toBe("2h 15m");
    expect(countdown(null, now)).toBe("–");
    expect(nextUtcMidnight(new Date("2026-09-30T23:59:00Z"))).toBe("2026-10-01T00:00:00.000Z");
  });

  it("turns relative signal weights into shares of the axis", () => {
    expect(weightShares([1.5, 0.8, 1, 0.6, 1.5, 1]).map((x) => Math.round(x))).toEqual([23, 13, 16, 9, 23, 16]);
    expect(weightShares([0, 0])).toEqual([0, 0]);
  });
});

describe("flag helpers", () => {
  it("validates integers and choices with readable errors", () => {
    expect(intFlag("--limit", undefined, 20)).toBe(20);
    expect(intFlag("--limit", "5", 20)).toBe(5);
    expect(() => intFlag("--limit", "500", 20)).toThrow("--limit must be a whole number from 1 to 100.");
    expect(() => intFlag("--limit", "3x", 20)).toThrow();
    expect(oneOf("--sort", "Popular", ["newest", "popular"] as const)).toBe("popular");
    expect(() => oneOf("--sort", "best", ["newest", "popular"] as const)).toThrow("--sort must be one of: newest, popular.");
  });

  it("builds query strings without empty values", () => {
    expect(query({ a: "x y", b: undefined, c: "", d: 2 })).toBe("?a=x+y&d=2");
    expect(query({})).toBe("");
  });

  it("turns a bare X handle into a URL", () => {
    expect(normalizeX("@kodwai")).toBe("https://x.com/kodwai");
    expect(normalizeX("https://x.com/kodwai")).toBe("https://x.com/kodwai");
    expect(normalizeX("")).toBe("");
  });
});

// Command-level: a fake API, --json output captured from stdout.
type Route = (url: URL, init: RequestInit) => unknown;
let routes: Record<string, Route>;
let calls: { method: string; path: string; body?: any }[];
let out: string;

beforeEach(() => {
  routes = {};
  calls = [];
  out = "";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method || "GET";
    calls.push({ method, path: url.pathname + url.search, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
    const res = handler(url, init);
    if (res instanceof Response) return res;
    return new Response(res === undefined ? "" : JSON.stringify(res), { status: 200 });
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...a: any[]) => {
    out += a.join(" ") + "\n";
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const API = { apiUrl: "http://api.test", json: true };

describe("kodwai challenges --json", () => {
  it("adds the user's best score and state to each challenge", async () => {
    routes["GET /api/challenges"] = () => [
      { id: "c1", slug: "a", title: "A", difficulty: "easy", category: "x", time_limit_minutes: 60, submission_count: 3, avg_score: 50 },
      { id: "c2", slug: "b", title: "B", difficulty: "hard", category: "y", time_limit_minutes: 90, submission_count: 0, avg_score: null },
    ];
    routes["GET /api/submissions/me"] = () => [
      { id: "s1", challenge_id: "c1", status: "scored", score: 61.5 },
      { id: "s2", challenge_id: "c1", status: "scored", score: 72 },
      { id: "s3", challenge_id: "c2", status: "in_progress", score: null },
    ];
    await listChallenges({ ...API, difficulty: "EASY", sort: "popular" });
    const data = JSON.parse(out);
    expect(data.map((c: any) => [c.slug, c.my_state, c.my_best_score])).toEqual([
      ["a", "solved", 72],
      ["b", "in progress", null],
    ]);
    expect(calls[0].path).toBe("/api/challenges?difficulty=easy&sort=popular&limit=50&page=1");
  });
});

describe("kodwai leaderboard --json", () => {
  it("says who the viewer is and that they aren't ranked, instead of a bare null", async () => {
    routes["GET /api/leaderboard"] = () => ({ entries: [{ id: "u9", username: "top", rank: 1, total_score: 90, challenges_completed: 4 }], total: 1, page: 1, limit: 25 });
    routes["GET /api/leaderboard/me/rank"] = () => ({ entry: null });
    routes["GET /api/auth/me"] = () => ({ id: "u1", username: "me" });
    await leaderboard(undefined, API);
    const data = JSON.parse(out);
    expect(data.viewer).toEqual({ username: "me", ranked: false });
    expect(data.me).toBeNull();
  });

  it("passes filters through and rejects unknown agents", async () => {
    routes["GET /api/leaderboard"] = () => ({ entries: [], total: 0, page: 1, limit: 25 });
    routes["GET /api/leaderboard/me/rank"] = () => ({ entry: null });
    routes["GET /api/auth/me"] = () => ({ id: "u1" });
    await leaderboard(undefined, { ...API, agent: "codex", model: "gpt-5", category: "data" });
    expect(calls.find((c) => c.path.startsWith("/api/leaderboard?"))?.path).toBe("/api/leaderboard?agent=codex&model=gpt-5&category=data&page=1&limit=25");
    await expect(leaderboard(undefined, { ...API, agent: "gemini" })).rejects.toThrow("--agent must be one of");
  });

  it("resolves a challenge slug to its id for the challenge board", async () => {
    routes["GET /api/challenges/rate-limiter"] = () => ({ id: "c7", slug: "rate-limiter", title: "Rate limiter" });
    routes["GET /api/leaderboard/challenges/c7"] = () => ({ entries: [{ rank: 1, user_id: "u1", score: 80 }], total: 1, page: 1, limit: 25 });
    routes["GET /api/auth/me"] = () => ({ id: "u1" });
    await leaderboard("rate-limiter", API);
    const data = JSON.parse(out);
    expect(data.viewer).toEqual({ user_id: "u1", on_this_page: true });
    expect(data.me.score).toBe(80);
  });
});

describe("writes", () => {
  it("claims only completed, unclaimed quests for `quests claim all`", async () => {
    routes["GET /api/quests"] = () => [
      { key: "daily_solve", completed: true, claimed: false, reward_xp: 50 },
      { key: "daily_high", completed: false, claimed: false, reward_xp: 75 },
      { key: "weekly_three", completed: true, claimed: true, reward_xp: 150 },
    ];
    routes["POST /api/quests/daily_solve/claim"] = () => ({ claimed: true, key: "daily_solve", reward_xp: 50 });
    await claimQuest("all", API);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/quests/daily_solve/claim"]);
    expect(JSON.parse(out)).toEqual([{ key: "daily_solve", reward_xp: 50 }]);
  });

  it("lowercases usernames and rejects bad ones before calling the API", async () => {
    routes["PATCH /api/auth/me/username"] = (_u, init) => ({ username: JSON.parse(String(init.body)).username });
    await setUsername("@New_Name", API);
    expect(calls[0].body).toEqual({ username: "new_name" });
    await expect(setUsername("no spaces!", API)).rejects.toThrow("Usernames are 3 to 50 characters");
  });

  it("maps feedback categories and requires 10 characters", async () => {
    routes["POST /api/feedback/platform"] = () => ({ id: "f1" });
    await sendFeedback("the league page is great", { ...API, category: "feature", rating: "5" });
    expect(calls[0].body).toEqual({ category: "feature_request", description: "the league page is great", page_url: "cli", rating: 5 });
    await expect(sendFeedback("short", API)).rejects.toThrow("10 characters");
    await expect(sendFeedback("long enough text", { ...API, category: "rant" })).rejects.toThrow("--category");
  });
});
