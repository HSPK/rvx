import type {JsonValue, StoredSnapshot} from "../domain/snapshots";
import {exactProperty, stringifyExact} from "../core/exact-json";

export function escapePointerToken(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function validPointer(pointer: string): boolean {
  return pointer === "" || (pointer.startsWith("/") && !/~(?:[^01]|$)/.test(pointer));
}

/** Bounded field discovery, including array indices and escaped object keys. */
export function numericFields(state: JsonValue, limit = 300): {paths: string[]; truncated: boolean} {
  const paths: string[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (value: JsonValue, path: string): void => {
    if (++visited > 10_000 || paths.length >= limit) {
      truncated = true;
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) paths.push(path);
    else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(child, `${path}/${escapePointerToken(key)}`);
        if (truncated) break;
      }
    }
  };
  walk(state, "");
  return {paths, truncated};
}

export function chronological(snapshots: StoredSnapshot[]): StoredSnapshot[] {
  return [...snapshots].sort((a, b) => a.observed_at_ns - b.observed_at_ns || a.id - b.id);
}

export function jsonPreview(value: JsonValue, limit = 32_000): {text: string; truncated: boolean} {
  const full = stringifyExact(value, 2);
  return {text: full.slice(0, limit), truncated: full.length > limit};
}

export function diffValue(change: {before?: JsonValue; after?: JsonValue}, side: "before" | "after"): string {
  return Object.hasOwn(change, side) ? exactProperty(change, side) : "(absent)";
}
