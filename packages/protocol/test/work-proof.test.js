import { describe, it, expect } from 'vitest'
import { buildWorkProof, mineWorkProof, verifyWorkProof } from '../src/work-proof.js'
import { workProofVectors, keyVectors } from './helpers/vectors.js'

// Admission-control work-proof reuses pow.js's mine/verify machinery unmodified — this
// suite exists to prove that reuse actually holds, and to cover the parts specific to
// this primitive: the `resource` binding and the `purpose`/type discriminator.

describe('verifyWorkProof — mined vectors', () => {
  for (const testCase of workProofVectors.mined) {
    it(`accepts a proof mined at ${testCase.required_difficulty} bits`, async () => {
      const result = await verifyWorkProof(testCase.work_proof, {
        difficulty: testCase.required_difficulty,
        now: workProofVectors.now,
        windowSeconds: workProofVectors.window_seconds,
      })
      expect(result.valid).toBe(true)
      expect(result.reason).toBe('valid')
    })
  }

  it('rejects a mined proof against a difficulty far beyond what it actually reached', async () => {
    // A far-beyond difficulty avoids a search-overshoot false negative: mine() stops at
    // the first nonce meeting or exceeding the target, so a mined proof's *actual*
    // difficulty can exceed what was asked for by a few bits — a "+small delta" check
    // would be flaky for exactly that reason.
    const testCase = workProofVectors.mined[0]
    const result = await verifyWorkProof(testCase.work_proof, {
      difficulty: 200,
      now: workProofVectors.now,
      windowSeconds: workProofVectors.window_seconds,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('insufficient_work')
  })
})

describe('verifyWorkProof — freshness and type', () => {
  const testCase = workProofVectors.mined[0]

  it('rejects a proof outside the freshness window', async () => {
    const result = await verifyWorkProof(testCase.work_proof, {
      difficulty: testCase.required_difficulty,
      now: testCase.work_proof.created_at + workProofVectors.window_seconds + 1,
      windowSeconds: workProofVectors.window_seconds,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('stale')
  })

  it('rejects an unknown work-proof type rather than trusting it', async () => {
    const unknown = { ...testCase.work_proof, type: 'something-else' }
    const result = await verifyWorkProof(unknown, {
      difficulty: testCase.required_difficulty,
      now: workProofVectors.now,
      windowSeconds: workProofVectors.window_seconds,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('unsupported_type')
  })
})

describe('buildWorkProof / mineWorkProof', () => {
  it('mines a proof from scratch that verifies', async () => {
    const unmined = buildWorkProof({
      purpose: 'compute-admission',
      subject: keyVectors.requester.pubkey,
      resource: 'job-request-fresh',
      createdAt: workProofVectors.now,
    })
    const mined = await mineWorkProof(unmined, 8, {})
    const result = await verifyWorkProof(mined, {
      difficulty: 8,
      now: workProofVectors.now,
      windowSeconds: workProofVectors.window_seconds,
    })
    expect(result.valid).toBe(true)
  })

  it('binds the proof to one resource — a different resource needs a fresh proof', async () => {
    const unmined = buildWorkProof({
      purpose: 'compute-admission',
      subject: keyVectors.requester.pubkey,
      resource: 'job-request-a',
      createdAt: workProofVectors.now,
    })
    const mined = await mineWorkProof(unmined, 8, {})
    const forAnotherResource = { ...mined, resource: 'job-request-b' }
    const result = await verifyWorkProof(forAnotherResource, {
      difficulty: 8,
      now: workProofVectors.now,
      windowSeconds: workProofVectors.window_seconds,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('insufficient_work')
  })
})
