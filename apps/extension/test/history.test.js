import { describe, it, expect } from 'vitest'
import { createHistoryStore } from '../src/worker/history.js'
import { createFakeStorage, createFakeClock } from './helpers.js'

describe('createHistoryStore', () => {
  it('starts empty', async () => {
    const history = createHistoryStore({ storage: createFakeStorage(), clock: createFakeClock() })
    expect(await history.list()).toEqual([])
  })

  it('records metadata only, never a prompt or result field', async () => {
    const history = createHistoryStore({ storage: createFakeStorage(), clock: createFakeClock() })
    await history.append({
      type: 'completed',
      capability: 'text.generate',
      model: 'qwen3:8b',
      durationSeconds: 2,
      usage: { promptTokens: 5, completionTokens: 10 },
    })
    const [entry] = await history.list()
    expect(entry).not.toHaveProperty('prompt')
    expect(entry).not.toHaveProperty('result')
    expect(entry.capability).toBe('text.generate')
    expect(entry.at).toBeTypeOf('number')
  })

  it('caps history length and keeps the newest entries first', async () => {
    const history = createHistoryStore({ storage: createFakeStorage(), clock: createFakeClock() })
    for (let index = 0; index < 55; index++) {
      await history.append({ type: 'completed', index })
    }
    const entries = await history.list()
    expect(entries).toHaveLength(50)
    expect(entries[0].index).toBe(54)
  })

  it('completedCount only counts completed entries', async () => {
    const history = createHistoryStore({ storage: createFakeStorage(), clock: createFakeClock() })
    await history.append({ type: 'completed' })
    await history.append({ type: 'failed', reason: 'timeout' })
    await history.append({ type: 'completed' })
    expect(await history.completedCount()).toBe(2)
  })
})
