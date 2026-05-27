import type { TraceTurn } from "./types.js";

/**
 * Rate the quality of a trace based on total turns and substantive user turns.
 *
 * Bands:
 *   full    — ≥15 total turns AND ≥5 user turns (rich, multi-round session)
 *   good    — ≥6 total turns AND ≥3 user turns (solid session)
 *   partial — ≥2 total turns (some signal)
 *   minimal — <2 turns or no user turns (barely any signal)
 */
export function rateTraceQuality(turns: TraceTurn[]): "full" | "good" | "partial" | "minimal" {
  const userTurns = turns.filter((t) => t.role === "user" && (t.content || "").trim().length > 0).length;
  const total = turns.length;
  if (total === 0 || userTurns === 0) return "minimal";
  if (total >= 15 && userTurns >= 5) return "full";
  if (total >= 6 && userTurns >= 3) return "good";
  if (total >= 2) return "partial";
  return "minimal";
}
