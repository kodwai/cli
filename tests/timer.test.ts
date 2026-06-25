import { describe, it, expect, vi, afterEach } from "vitest";
import { createTimer } from "../src/session/timer.js";

describe("Timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should report correct remaining time", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const timer = createTimer(10, onExpired);

    expect(timer.remaining()).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(timer.remaining()).toBeGreaterThan(9 * 60 * 1000);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(timer.remaining()).toBeLessThanOrEqual(5 * 60 * 1000);

    timer.stop();
  });

  it("should call onExpired when timer runs out", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    createTimer(1, onExpired);

    vi.advanceTimersByTime(60 * 1000);
    expect(onExpired).toHaveBeenCalledOnce();
  });

  it("should not call onExpired if stopped early", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const timer = createTimer(1, onExpired);

    vi.advanceTimersByTime(30 * 1000);
    timer.stop();
    vi.advanceTimersByTime(60 * 1000);

    expect(onExpired).not.toHaveBeenCalled();
  });

  it("should allow overriding onExpired callback", () => {
    vi.useFakeTimers();
    const original = vi.fn();
    const override = vi.fn();
    const timer = createTimer(1, original);

    timer.onExpired(override);
    vi.advanceTimersByTime(60 * 1000);

    expect(original).not.toHaveBeenCalled();
    expect(override).toHaveBeenCalledOnce();
  });
});
