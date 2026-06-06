/**
 * Pick the primary (most-used) model from a list of per-turn/per-bubble model
 * names. Ignores empty values and Cursor's "default" sentinel. Ties resolve to
 * the first model seen. Returns undefined when there is no usable signal.
 */
export function pickPrimaryModel(raw: (string | null | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const r of raw) {
    if (!r) continue;
    const name = r.trim();
    if (!name || name.toLowerCase() === "default") continue;
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const name of order) {
    const c = counts.get(name)!;
    if (c > bestCount) {
      best = name;
      bestCount = c;
    }
  }
  return best;
}
