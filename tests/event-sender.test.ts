import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createEventSender } from "../src/streaming/event-sender.js";

describe("EventSender", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockResolvedValue({ ok: true, status: 201 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should send events to the correct endpoint", async () => {
    const sender = createEventSender("sess-123", "secret", "http://localhost:8000");

    // System events are sent immediately (priority)
    await sender.send({
      event_type: "system",
      data: { subtype: "init" },
      timestamp: "2026-01-01T00:00:00Z",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/sessions/sess-123/events");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-Kodwai-Session"]).toBe("sess-123");
  });

  it("should sign requests with HMAC-SHA256", async () => {
    const sender = createEventSender("sess-123", "my-secret", "http://localhost:8000");

    await sender.send({
      event_type: "system",
      data: null,
      timestamp: "2026-01-01T00:00:00Z",
    });

    const [, opts] = mockFetch.mock.calls[0];
    const body = opts.body;
    const expectedSig = createHmac("sha256", "my-secret").update(body).digest("hex");

    expect(opts.headers["X-Kodwai-Signature"]).toBe(`sha256=${expectedSig}`);
  });

  it("should batch non-priority events", async () => {
    const sender = createEventSender("sess-123", "secret", "http://localhost:8000");

    // Send 3 assistant events (non-priority, will be batched)
    await sender.send({ event_type: "assistant", data: { n: 1 }, timestamp: "2026-01-01T00:00:00Z" });
    await sender.send({ event_type: "assistant", data: { n: 2 }, timestamp: "2026-01-01T00:00:01Z" });
    await sender.send({ event_type: "assistant", data: { n: 3 }, timestamp: "2026-01-01T00:00:02Z" });

    // Not flushed yet (waiting for batch timer)
    expect(mockFetch).not.toHaveBeenCalled();

    // Advance past flush interval (500ms)
    await vi.advanceTimersByTimeAsync(600);

    // Should have flushed
    expect(mockFetch).toHaveBeenCalled();
  });

  it("should send end request", async () => {
    const sender = createEventSender("sess-123", "secret", "http://localhost:8000");

    await sender.sendEnd({ end_reason: "completed", total_cost_usd: 1.5 });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/sessions/sess-123/end");
    expect(JSON.parse(opts.body)).toEqual({ end_reason: "completed", total_cost_usd: 1.5 });
  });

  it("should not throw if fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const sender = createEventSender("sess-123", "secret", "http://localhost:8000");

    // Should not throw
    await sender.send({
      event_type: "system",
      data: null,
      timestamp: "2026-01-01T00:00:00Z",
    });
  });
});
