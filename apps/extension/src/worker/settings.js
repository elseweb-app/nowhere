// Persisted worker configuration (root AGENTS.md "Worker" and "Extension UI"
// sections). Kept separate from the owner identity (src/platform via
// createKeyStore in @elseweb-app/client) and the worker keypair/delegation
// (createWorkerIdentityStore) — this is only the user-facing switches: is the worker
// on, which provider/models/capabilities it may use, and its local limits.

import { DEFAULT_LIMITS } from './limits.js'

const STORAGE_KEY = 'elseweb.worker-settings'

export const DEFAULT_SETTINGS = {
  enabled: false,
  relayUrl: null,
  providerId: null,
  providerBaseUrl: null,
  allowedModels: [],
  capabilities: ['text.generate', 'code.generate'],
  limits: DEFAULT_LIMITS,
}

export function createSettingsStore({ storage }) {
  if (!storage || typeof storage.get !== 'function') {
    throw new TypeError('createSettingsStore requires an injected storage port')
  }

  async function get() {
    const stored = await storage.get(STORAGE_KEY)
    return stored ? { ...DEFAULT_SETTINGS, ...stored } : { ...DEFAULT_SETTINGS }
  }

  async function update(patch) {
    const current = await get()
    const next = { ...current, ...patch }
    await storage.set(STORAGE_KEY, next)
    return next
  }

  return { get, update }
}
