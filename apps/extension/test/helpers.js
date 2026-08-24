export function createFakeStorage() {
  const store = new Map()
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : undefined
    },
    async set(key, value) {
      store.set(key, value)
    },
    async remove(key) {
      store.delete(key)
    },
  }
}

export function createFakeClock(startSeconds = 1_700_000_000) {
  let current = startSeconds
  return {
    now: () => current,
    advance(seconds) {
      current += seconds
    },
  }
}
