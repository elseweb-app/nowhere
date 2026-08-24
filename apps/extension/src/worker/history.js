// Local job history: metadata only, per root AGENTS.md's "Privacy" section — time,
// capability, local model, duration, token usage, success/failure. Never a prompt or a
// result; src/worker/job-runner.js never hands this store anything but that metadata.

const STORAGE_KEY = 'elseweb.worker-history'
const MAX_ENTRIES = 50

export function createHistoryStore({ storage, clock }) {
  if (!storage || typeof storage.get !== 'function') {
    throw new TypeError('createHistoryStore requires an injected storage port')
  }
  if (!clock || typeof clock.now !== 'function') {
    throw new TypeError('createHistoryStore requires an injected clock port')
  }

  async function list() {
    return (await storage.get(STORAGE_KEY)) ?? []
  }

  async function append(entry) {
    const current = await list()
    const next = [{ at: clock.now(), ...entry }, ...current].slice(0, MAX_ENTRIES)
    await storage.set(STORAGE_KEY, next)
    return next
  }

  async function completedCount() {
    return (await list()).filter((entry) => entry.type === 'completed').length
  }

  async function clear() {
    await storage.set(STORAGE_KEY, [])
  }

  return { list, append, completedCount, clear }
}
