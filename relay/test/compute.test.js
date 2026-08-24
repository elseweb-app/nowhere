import { describe, it, expect } from 'vitest'
import { generateAuthorizationId, difficultyOf } from '@elseweb/protocol'
import { createRelayApp } from '../src/index.js'
import { createMemoryStore } from './memory-store.js'
import { createMemoryComputeStore } from './memory-compute-store.js'
import {
  createFakeClock,
  makeTestConfig,
  makeAuthor,
  buildMinedWorkProof,
  buildSignedDelegation,
  buildSignedRevocation,
} from './fixtures.js'

function makeApp(overrides = {}) {
  const clock = createFakeClock()
  const config = makeTestConfig(overrides)
  const app = createRelayApp({
    store: createMemoryStore(),
    computeStore: createMemoryComputeStore(),
    config,
    clock,
  })
  return { app, clock, config }
}

async function createJob(app, { requester, capability = 'text.generate', now, jobId }) {
  const id = jobId ?? generateAuthorizationId()
  const workProof = await buildMinedWorkProof({ subject: requester.pubkey, resource: id, now })
  const response = await app.handle(
    new Request('http://relay.test/compute/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requester_pubkey: requester.pubkey,
        capability,
        work_proof: workProof,
      }),
    })
  )
  return { response, body: await response.json(), jobId: id }
}

describe('compute job lifecycle', () => {
  it('creates a pending job with a valid work proof, no prompt in the payload', async () => {
    const { app, clock } = makeApp()
    const requester = await makeAuthor()
    const { response, body } = await createJob(app, { requester, now: clock.now() })

    expect(response.status).toBe(201)
    expect(body.job.status).toBe('pending')
    expect(body.job).not.toHaveProperty('prompt')
    expect(body.job).not.toHaveProperty('result')
  })

  it('rejects job creation with an insufficient work proof', async () => {
    const { app, clock, config } = makeApp()
    const requester = await makeAuthor()
    const jobId = generateAuthorizationId()
    // Mine at difficulty 0 (accepts the first digest tried), then deterministically
    // pick a proof whose actual difficulty still falls short of what the relay
    // requires, so the test never depends on chance.
    let workProof = await buildMinedWorkProof({
      subject: requester.pubkey,
      resource: jobId,
      now: clock.now(),
      difficulty: 0,
    })
    while (difficultyOf(workProof.id) >= config.compute.jobAdmissionDifficulty) {
      workProof = await buildMinedWorkProof({
        subject: requester.pubkey,
        resource: jobId,
        now: clock.now() + 1,
        difficulty: 0,
      })
    }

    const response = await app.handle(
      new Request('http://relay.test/compute/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requester_pubkey: requester.pubkey,
          capability: 'text.generate',
          work_proof: workProof,
        }),
      })
    )
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('WORK_PROOF_INVALID')
  })

  it('lists a pending job by capability for a polling worker', async () => {
    const { app, clock } = makeApp()
    const requester = await makeAuthor()
    await createJob(app, { requester, now: clock.now() })

    const response = await app.handle(
      new Request('http://relay.test/compute/jobs?capability=text.generate')
    )
    const body = await response.json()
    expect(body.jobs).toHaveLength(1)
  })

  it('lets a worker with a valid delegation claim a pending job', async () => {
    const { app, clock } = makeApp()
    const requester = await makeAuthor()
    const owner = await makeAuthor()
    const worker = await makeAuthor()
    const { jobId } = await createJob(app, { requester, now: clock.now() })

    const delegation = await buildSignedDelegation({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.pubkey,
      workerPubkey: worker.pubkey,
      capabilities: ['text.generate'],
      issuedAt: clock.now(),
      expiresAt: clock.now() + 3600,
    })

    const response = await app.handle(
      new Request(`http://relay.test/compute/jobs/${jobId}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delegation }),
      })
    )
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.job.status).toBe('claimed')
    expect(body.job.worker_pubkey).toBe(worker.pubkey)
  })

  it('rejects a claim whose delegation does not cover the job capability', async () => {
    const { app, clock } = makeApp()
    const requester = await makeAuthor()
    const owner = await makeAuthor()
    const worker = await makeAuthor()
    const { jobId } = await createJob(app, {
      requester,
      capability: 'code.generate',
      now: clock.now(),
    })

    const delegation = await buildSignedDelegation({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.pubkey,
      workerPubkey: worker.pubkey,
      capabilities: ['text.generate'],
      issuedAt: clock.now(),
      expiresAt: clock.now() + 3600,
    })

    const response = await app.handle(
      new Request(`http://relay.test/compute/jobs/${jobId}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delegation }),
      })
    )
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.code).toBe('DELEGATION_INVALID')
  })

  it('a second claim on an already-claimed job is rejected', async () => {
    const { app, clock } = makeApp()
    const requester = await makeAuthor()
    const owner = await makeAuthor()
    const workerA = await makeAuthor()
    const workerB = await makeAuthor()
    const { jobId } = await createJob(app, { requester, now: clock.now() })

    const makeDelegation = (worker) =>
      buildSignedDelegation({
        ownerPrivateKey: owner.privateKey,
        ownerPubkey: owner.pubkey,
        workerPubkey: worker.pubkey,
        capabilities: ['text.generate'],
        issuedAt: clock.now(),
        expiresAt: clock.now() + 3600,
      })

    const claim = (delegation) =>
      app.handle(
        new Request(`http://relay.test/compute/jobs/${jobId}/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ delegation }),
        })
      )

    await claim(await makeDelegation(workerA))
    const second = await claim(await makeDelegation(workerB))
    expect(second.status).toBe(409)
  })

  it('exchanges WebRTC signaling messages through the per-job mailbox', async () => {
    const { app, clock } = makeApp()
    const requester = await makeAuthor()
    const owner = await makeAuthor()
    const worker = await makeAuthor()
    const { jobId } = await createJob(app, { requester, now: clock.now() })

    const delegation = await buildSignedDelegation({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.pubkey,
      workerPubkey: worker.pubkey,
      capabilities: ['text.generate'],
      issuedAt: clock.now(),
      expiresAt: clock.now() + 3600,
    })
    await app.handle(
      new Request(`http://relay.test/compute/jobs/${jobId}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delegation }),
      })
    )

    const post = (fromPubkey, kind, data) =>
      app.handle(
        new Request(`http://relay.test/compute/jobs/${jobId}/signal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from_pubkey: fromPubkey, kind, data }),
        })
      )

    await post(requester.pubkey, 'offer', { sdp: 'fake-offer' })
    await post(worker.pubkey, 'answer', { sdp: 'fake-answer' })

    const response = await app.handle(
      new Request(`http://relay.test/compute/jobs/${jobId}/signal?since=-1`)
    )
    const body = await response.json()
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].kind).toBe('offer')
    expect(body.messages[1].kind).toBe('answer')
  })

  it('a revoked delegation fails claim once the relay has stored the revocation', async () => {
    const { app, clock } = makeApp()
    const requester = await makeAuthor()
    const owner = await makeAuthor()
    const worker = await makeAuthor()
    const { jobId } = await createJob(app, { requester, now: clock.now() })

    const delegation = await buildSignedDelegation({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.pubkey,
      workerPubkey: worker.pubkey,
      capabilities: ['text.generate'],
      issuedAt: clock.now(),
      expiresAt: clock.now() + 3600,
    })

    const revocation = await buildSignedRevocation({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.pubkey,
      authorizationId: delegation.authorization_id,
      revokedAt: clock.now(),
    })
    await app.handle(
      new Request('http://relay.test/compute/revocations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(revocation),
      })
    )

    const response = await app.handle(
      new Request(`http://relay.test/compute/jobs/${jobId}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delegation }),
      })
    )
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error.reason ?? body.error.message).toBeTruthy()
    expect(body.error.code).toBe('DELEGATION_INVALID')
  })

  it('/compute/* 404s when a binding has no computeStore configured', async () => {
    const clock = createFakeClock()
    const app = createRelayApp({ store: createMemoryStore(), config: makeTestConfig(), clock })
    const response = await app.handle(
      new Request('http://relay.test/compute/jobs?capability=text.generate')
    )
    expect(response.status).toBe(404)
  })
})
