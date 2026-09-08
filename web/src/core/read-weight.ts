const weights = new WeakMap<object, number>();

/** Keeps conservative decoded-response accounting without reserializing snapshot trees. */
export function recordReadWeight(value: unknown, wireCharacters: number): void {
  if (value !== null && typeof value === "object") {
    weights.set(value, Math.max(256, wireCharacters * 8));
  }
}

/** Uses transport accounting or a bounded fallback for non-HTTP clients and fixtures. */
export function readWeight(value: unknown): number {
  if (value !== null && typeof value === "object") {
    const recorded = weights.get(value);
    if (recorded !== undefined) return recorded;
  }
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  while (pending.length) {
    if (++nodes > 50_000) return Infinity;
    const item = pending.pop();
    bytes += 32;
    if (typeof item === "string") bytes += item.length * 2;
    else if (item !== null && typeof item === "object") {
      if (visited.has(item)) continue;
      visited.add(item);
      if (Array.isArray(item)) {
        if (item.length + pending.length > 50_000) return Infinity;
        pending.push(...item);
      } else {
        for (const [key, child] of Object.entries(item)) {
          bytes += key.length * 2 + 32;
          pending.push(child);
          if (pending.length > 50_000) return Infinity;
        }
      }
    }
  }
  return bytes;
}
