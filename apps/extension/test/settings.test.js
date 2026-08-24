import { describe, it, expect } from 'vitest'
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/worker/settings.js'
import { createFakeStorage } from './helpers.js'

describe('createSettingsStore', () => {
  it('returns defaults before anything is stored', async () => {
    const settings = createSettingsStore({ storage: createFakeStorage() })
    expect(await settings.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('update() merges a patch and persists it', async () => {
    const settings = createSettingsStore({ storage: createFakeStorage() })
    const updated = await settings.update({ enabled: true, allowedModels: ['qwen3:8b'] })
    expect(updated.enabled).toBe(true)
    expect(updated.allowedModels).toEqual(['qwen3:8b'])
    expect(await settings.get()).toEqual(updated)
  })

  it('backfills defaults for fields a stored record predates', async () => {
    const storage = createFakeStorage()
    await storage.set('elseweb.worker-settings', { enabled: true })
    const settings = createSettingsStore({ storage })
    const result = await settings.get()
    expect(result.enabled).toBe(true)
    expect(result.capabilities).toEqual(DEFAULT_SETTINGS.capabilities)
  })
})
