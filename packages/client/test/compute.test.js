import { describe, it, expect, vi } from 'vitest'
import { generateKeyPair, signReceiptAsWorker } from '@elseweb/protocol'
import { createComputeClient } from '../src/compute.js'
import { createFakeClock, jsonResponse } from './helpers.js'

describe('createComputeClient construction', () => {
  it('requires a url', () => {
    expect(() => createComputeClient({ fetch: vi.fn(), clock: createFakeClock() })).toThrow()
  })
  it('requires an injected fetch implementation', () => {
    expect(() =>
      createComputeClient({ url: 'https://relay.example', clock: createFakeClock() })
    ).toThrow()
  })
  it('requires an injected clock', () => {
    expect(() => createComputeClient({ url: 'https://relay.example', fetch: vi.fn() })).toThrow()
  })
})

describe('submitJob', () => {
  it('mines a work proof and posts it with no prompt in the body', async () => {
    const clock = createFakeClock()
    const author = await generateKeyPair()
    let capturedBody = null
    const fetchSpy = vi.fn(async (url, options) => {
      capturedBody = JSON.parse(options.body)
      return jsonResponse({ job: { job_id: 'abc', status: 'pending' } }, { status: 201 })
    })
    const compute = createComputeClient({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await compute.submitJob({
      jobId: '00000000000000000000000000000abc'.slice(0, 32),
      requesterPubkey: author.publicKey,
      capability: 'text.generate',
      difficulty: 1,
    })

    expect(result.ok).toBe(true)
    expect(result.job.status).toBe('pending')
    expect(capturedBody).not.toHaveProperty('prompt')
    expect(capturedBody.work_proof.subject).toBe(author.publicKey)
  })

  it('turns a rejection into a typed, non-throwing outcome', async () => {
    const clock = createFakeClock()
    const author = await generateKeyPair()
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ error: { code: 'WORK_PROOF_INVALID', message: 'nope' } }, { status: 400 })
    )
    const compute = createComputeClient({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await compute.submitJob({
      jobId: 'a'.repeat(32),
      requesterPubkey: author.publicKey,
      capability: 'text.generate',
      difficulty: 1,
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('WORK_PROOF_INVALID')
  })
})

describe('pollJobs / claimJob', () => {
  it('lists pending jobs for a capability', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async (url) => {
      expect(url).toContain('/compute/jobs?capability=text.generate')
      return jsonResponse({ jobs: [{ job_id: 'x' }] })
    })
    const compute = createComputeClient({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await compute.pollJobs({ capability: 'text.generate' })
    expect(result.ok).toBe(true)
    expect(result.jobs).toHaveLength(1)
  })

  it('degrades to an empty list rather than throwing on a network failure', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline')
    })
    const compute = createComputeClient({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await compute.pollJobs({ capability: 'text.generate' })
    expect(result.ok).toBe(false)
    expect(result.jobs).toEqual([])
  })

  it('claims a job by posting a delegation', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => jsonResponse({ job: { job_id: 'x', status: 'claimed' } }))
    const compute = createComputeClient({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await compute.claimJob({ jobId: 'x', delegation: { type: 'worker-delegation' } })
    expect(result.ok).toBe(true)
    expect(result.job.status).toBe('claimed')
  })
})

describe('signaling', () => {
  it('posts and lists signaling messages', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async (url, options) => {
      if (options?.method === 'POST') return jsonResponse({ index: 0 }, { status: 201 })
      return jsonResponse({ messages: [{ index: 0, kind: 'offer' }] })
    })
    const compute = createComputeClient({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const posted = await compute.postSignal({
      jobId: 'x',
      fromPubkey: 'a'.repeat(64),
      kind: 'offer',
      data: { sdp: 'fake' },
    })
    expect(posted.ok).toBe(true)

    const listed = await compute.listSignals({ jobId: 'x' })
    expect(listed.ok).toBe(true)
    expect(listed.messages).toHaveLength(1)
  })
})

describe('receipts', () => {
  it('rejects submitting a receipt that is not schema-valid, without a network call', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn()
    const compute = createComputeClient({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await compute.submitReceipt({ jobId: 'x', receipt: { not: 'valid' } })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('SCHEMA_INVALID')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('submits an already worker-signed receipt', async () => {
    const clock = createFakeClock()
    const worker = await generateKeyPair()
    const requester = await generateKeyPair()
    const unsigned = {
      v: 1,
      type: 'compute-receipt',
      job_id: 'a'.repeat(32),
      requester_pubkey: requester.publicKey,
      worker_pubkey: worker.publicKey,
      capability: 'text.generate',
      usage: { unit: 'tokens', amount: 10 },
      result_hash: 'b'.repeat(64),
      started_at: clock.now(),
      finished_at: clock.now() + 1,
    }
    const receipt = await signReceiptAsWorker(unsigned, worker.privateKey)

    const fetchSpy = vi.fn(async () =>
      jsonResponse({ job: { job_id: 'a'.repeat(32), status: 'done' } })
    )
    const compute = createComputeClient({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await compute.submitReceipt({ jobId: receipt.job_id, receipt })
    expect(result.ok).toBe(true)
    expect(result.job.status).toBe('done')
  })
})
