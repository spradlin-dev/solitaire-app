// Minimal structural subset of the DOM Storage interface: localStorage
// satisfies it directly, and tests inject in-memory fakes.
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
