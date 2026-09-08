let serial = 0;

/** Generates opaque UI identities across reloads, including HTTP hosts without randomUUID. */
export function uiIdentifier(prefix: string): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
  if (typeof crypto?.getRandomValues === "function") {
    const words = crypto.getRandomValues(new Uint32Array(4));
    return `${prefix}-${Array.from(words, word => word.toString(16).padStart(8, "0")).join("")}`;
  }
  // These are UI identities, never passwords or authentication tokens.
  return `${prefix}-${Date.now().toString(36)}-${++serial}-${Math.random().toString(36).slice(2)}`;
}
