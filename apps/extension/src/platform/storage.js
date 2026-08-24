// The storage port packages/client's createKeyStore/createWorkerIdentityStore expect:
// get(key)/set(key, value)/remove(key). chrome.storage.local lives here and nowhere
// else in this app (apps/extension/AGENTS.md, "Configuration").

export function createChromeStorage(area = chrome.storage.local) {
  return {
    async get(key) {
      const record = await area.get(key)
      return record[key]
    },
    async set(key, value) {
      await area.set({ [key]: value })
    },
    async remove(key) {
      await area.remove(key)
    },
  }
}
