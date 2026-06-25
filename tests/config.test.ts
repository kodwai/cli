import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSessionConfig } from "../src/session/config.js";

describe("fetchSessionConfig", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should fetch config from the correct URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        session_id: "sess-123",
        session_token: "tok",
        webhook_secret: "secret",
        api_key: "sk-ant-test",
        project_title: "Test",
        problem_statement_md: "Do something",
        time_limit_minutes: 60,
        difficulty: null,
        allowed_tools: null,
        disallowed_tools: null,
        rubric: [],
        max_budget_usd: null,
        starter_files: null,
      }),
    });

    const config = await fetchSessionConfig("sess-123", "http://localhost:8000");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/api/sessions/sess-123/config?session_token=sess-123"
    );
    expect(config.project_title).toBe("Test");
    expect(config.api_key).toBe("sk-ant-test");
  });

  it("should throw on 404", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ detail: "Not found" }),
    });

    await expect(fetchSessionConfig("bad-id", "http://localhost:8000"))
      .rejects.toThrow("Session not found");
  });

  it("should throw on 400 with detail", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ detail: "Session is already 'active'" }),
    });

    await expect(fetchSessionConfig("sess-123", "http://localhost:8000"))
      .rejects.toThrow("Session is already 'active'");
  });
});
