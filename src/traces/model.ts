// Sentinels that agents record in the model field but which are not real models:
// Cursor's "default" (auto model selector) and Claude Code's "<synthetic>"
// marker for system/synthetic messages.
const NON_MODEL_SENTINELS = new Set(["default", "<synthetic>"]);

/**
 * Pick the primary (most-used) model from a list of per-turn/per-bubble model
 * names. Ignores empty values and non-model sentinels ("default", "<synthetic>").
 * Ties resolve to the first model seen. Returns undefined when there is no
 * usable signal.
 */
export function pickPrimaryModel(raw: (string | null | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const r of raw) {
    if (!r) continue;
    const name = r.trim();
    if (!name || NON_MODEL_SENTINELS.has(name.toLowerCase())) continue;
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
