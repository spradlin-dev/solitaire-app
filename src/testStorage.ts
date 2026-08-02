import type { StorageLike } from './storage.ts'

// In-memory StorageLike for tests; dump() exposes the raw map for
// assertions about what was actually written.
export function fakeStorage(): StorageLike & { dump(): Map<string, string> } {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    dump: () => data,
  }
}
