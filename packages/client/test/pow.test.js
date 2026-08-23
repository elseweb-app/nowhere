import { describe, it, expect } from 'vitest'
import { createMiner } from '../src/pow.js'
import { isElsewebError } from '../src/errors.js'
import { makeShareDraft, makeAuthor, createFakeClock } from './helpers.js'

async function makeDraft() {
  const clock = createFakeClock()
  const author = await makeAuthor()
  const draft = await makeShareDraft({ pubkey: author.pubkey, now: clock.now() })
  return draft
}

describe('createMiner', () => {
  it('delegates to protocol mine() and returns a nonce/id-bearing event', async () => {
    const draft = await makeDraft()
    const miner = createMiner()

    const mined = await miner.mine(draft, 0)

    expect(typeof mined.nonce).toBe('number')
    expect(mined.id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports progress through the injected onProgress callback', async () => {
    const draft = await makeDraft()
    const progressCalls = []
    const miner = createMiner({ onProgress: (progress) => progressCalls.push(progress) })

    // Difficulty high enough that mining crosses at least one progress checkpoint
    // before it happens to succeed, without making the test slow.
    await miner.mine(draft, 10)

    expect(progressCalls.length).toBeGreaterThan(0)
  })

  it('surfaces MINING_ABORTED when the signal fires', async () => {
    const draft = await makeDraft()
    const miner = createMiner()
    const controller = new AbortController()
    controller.abort()

    await expect(miner.mine(draft, 32, { signal: controller.signal })).rejects.toSatisfy(
      (error) => isElsewebError(error) && error.code === 'MINING_ABORTED'
    )
  })

  it('surfaces MINING_EXHAUSTED when maxIterations is exceeded', async () => {
    const draft = await makeDraft()
    // A difficulty this high will not be met within a handful of iterations, so the
    // bounded-effort path is what ends the search rather than luck.
    const miner = createMiner({ maxIterations: 3 })

    await expect(miner.mine(draft, 40)).rejects.toSatisfy(
      (error) => isElsewebError(error) && error.code === 'MINING_EXHAUSTED'
    )
  })
})
