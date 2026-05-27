import { describe, it, expect } from "vitest";
import { rateTraceQuality } from "../src/traces/quality.js";
import type { TraceTurn } from "../src/traces/types.js";

/** Build a turns array with `userCount` user turns and fill the rest with assistant turns. */
function makeTurns(total: number, userCount: number): TraceTurn[] {
  const turns: TraceTurn[] = [];
  for (let i = 0; i < total; i++) {
    if (i < userCount) {
      turns.push({ role: "user", content: "some user message" });
    } else {
      turns.push({ role: "assistant", content: "some assistant reply" });
    }
  }
  return turns;
}

describe("rateTraceQuality", () => {
  it('returns "minimal" for 0 turns', () => {
    expect(rateTraceQuality([])).toBe("minimal");
  });

  it('returns "minimal" when there are turns but no user turns', () => {
    const turns: TraceTurn[] = [
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    expect(rateTraceQuality(turns)).toBe("minimal");
  });

  it('returns "minimal" for 1 turn (user) — below partial threshold', () => {
    expect(rateTraceQuality(makeTurns(1, 1))).toBe("minimal");
  });

  it('returns "partial" for 3 turns with 1 user turn', () => {
    expect(rateTraceQuality(makeTurns(3, 1))).toBe("partial");
  });

  it('returns "partial" for exactly 2 turns with 1 user turn', () => {
    expect(rateTraceQuality(makeTurns(2, 1))).toBe("partial");
  });

  it('returns "good" for 6 turns with 3 user turns', () => {
    expect(rateTraceQuality(makeTurns(6, 3))).toBe("good");
  });

  it('returns "good" for 10 turns with 4 user turns (above good threshold, below full)', () => {
    expect(rateTraceQuality(makeTurns(10, 4))).toBe("good");
  });

  it('returns "full" for 16 turns with 6 user turns', () => {
    expect(rateTraceQuality(makeTurns(16, 6))).toBe("full");
  });

  it('returns "full" for exactly 15 turns with 5 user turns (boundary)', () => {
    expect(rateTraceQuality(makeTurns(15, 5))).toBe("full");
  });

  it('returns "good" when total >= 15 but user turns < 5', () => {
    // 15 total, 4 user — doesn't meet full criteria, but meets good (total>=6, user>=3)
    expect(rateTraceQuality(makeTurns(15, 4))).toBe("good");
  });

  it('ignores user turns with empty/whitespace content', () => {
    const turns: TraceTurn[] = [
      { role: "user", content: "   " },
      { role: "user", content: "" },
      { role: "assistant", content: "response" },
      { role: "assistant", content: "response2" },
    ];
    // total=4, substantive userTurns=0 → minimal
    expect(rateTraceQuality(turns)).toBe("minimal");
  });
});
