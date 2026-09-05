// Explicit legacy browser-state migration; never overwrite newer RVX preferences.
const LEGACY_STORAGE_KEYS = {
  "rvx.workspace.snapshots.v1": "ryx.workspace.snapshots.v1",
  "rvx.layout.context": "ryx.layout.context",
  "rvx.layout.split": "ryx.layout.split",
} as const;

export type BrowserStorageKey = keyof typeof LEGACY_STORAGE_KEYS;

export function readBrowserStorage(key: BrowserStorageKey): string | null {
  try {
    const storage = window.localStorage;
    const current = storage.getItem(key);
    if (current !== null) return current;
    const legacy = storage.getItem(LEGACY_STORAGE_KEYS[key]);
    if (legacy !== null) {
      try {
        storage.setItem(key, legacy);
      } catch {
        // Read legacy preferences even when storage is full or read-only.
      }
    }
    return legacy;
  } catch {
    return null;
  }
}
