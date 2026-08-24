import { describe, it, expect } from 'vitest'
import { generateKeyPair } from '@elseweb/protocol'
import { createWorkerIdentityStore, negotiateAsOfferer } from '@elseweb-app/client'
import { runWorkerTick } from '../src/worker/background-worker.js'
import { createSettingsStore } from '../src/worker/settings.js'
import { createHistoryStore } from '../src/worker/history.js'
import { DEFAULT_LIMITS } from '../src/worker/limits.js'
import { createFakeStorage, createFakeClock } from './helpers.js'
import { createFakeRTCPeerConnectionClass } from './fake-webrtc.js'

// A minimal fake of createComputeClient's surface, backed by an in-memory job and
// signaling store — proves the background worker's orchestration (poll -> claim ->
// negotiate -> execute -> receipt) end to end without a real relay or WebRTC stack.
function createFakeComputeClient() {
  const jobs = new Map()
  const signals = []
  return {
    seedPendingJob(job) {
      jobs.set(job.job_id, job)
    },
    async pollJobs({ capability }) {
      return {
        ok: true,
        jobs: [...jobs.values()].filter(
          (job) => job.status === 'pending' && job.capability === capability
        ),
      }
    },
    async claimJob({ jobId, delegation }) {
      const job = jobs.get(jobId)
      if (!job || job.status !== 'pending') return { ok: false, code: 'JOB_NOT_CLAIMABLE' }
      job.status = 'claimed'
      job.worker_pubkey = delegation.worker_pubkey
      return { ok: true, job }
    },
    async postSignal({ jobId, fromPubkey, kind, data }) {
      signals.push({ index: signals.length, jobId, from_pubkey: fromPubkey, kind, data })
      return { ok: true, index: signals.length - 1 }
    },
    async listSignals({ jobId, since = -1 }) {
      return {
        ok: true,
        messages: signals.filter((message) => message.jobId === jobId && message.index > since),
      }
    },
    async submitReceipt({ jobId, receipt }) {
      const job = jobs.get(jobId)
      job.status = 'done'
      job.receipt = receipt
      return { ok: true, job }
    },
  }
}

async function setUpWorker({ capability = 'text.generate', model = 'qwen3:8b' } = {}) {
  const clock = createFakeClock()
  const storage = createFakeStorage()
  const settingsStore = createSettingsStore({ storage })
  const historyStore = createHistoryStore({ storage, clock })
  const workerIdentityStore = createWorkerIdentityStore({ storage, clock })
  await workerIdentityStore.createWorker()

  const owner = await generateKeyPair()
  await workerIdentityStore.authorize({
    ownerPrivateKey: owner.privateKey,
    ownerPubkey: owner.publicKey,
    capabilities: [capability],
  })
  await settingsStore.update({
    enabled: true,
    allowedModels: [model],
    capabilities: [capability],
    limits: { ...DEFAULT_LIMITS, executionTimeoutMs: 2000 },
  })

  return { clock, settingsStore, historyStore, workerIdentityStore }
}

describe('runWorkerTick', () => {
  it('does nothing while the worker is disabled', async () => {
    const clock = createFakeClock()
    const storage = createFakeStorage()
    const settingsStore = createSettingsStore({ storage })
    const historyStore = createHistoryStore({ storage, clock })
    const workerIdentityStore = createWorkerIdentityStore({ storage, clock })

    const result = await runWorkerTick({
      settingsStore,
      workerIdentityStore,
      computeClient: createFakeComputeClient(),
      provider: {},
      RTCPeerConnection: createFakeRTCPeerConnectionClass(),
      clock,
      historyStore,
    })
    expect(result).toEqual({ ranJob: false, reason: 'disabled' })
  })

  it('claims a pending job, runs it through a fake provider, and submits a valid receipt', async () => {
    const { clock, settingsStore, historyStore, workerIdentityStore } = await setUpWorker()
    const computeClient = createFakeComputeClient()
    const RTCPeerConnection = createFakeRTCPeerConnectionClass()

    const requesterPubkey = 'r'.repeat(64)
    const jobId = 'a'.repeat(32)
    computeClient.seedPendingJob({
      job_id: jobId,
      capability: 'text.generate',
      status: 'pending',
      requester_pubkey: requesterPubkey,
    })

    const provider = {
      async generateText() {
        return { ok: true, text: 'the answer', usage: { promptTokens: 4, completionTokens: 2 } }
      },
    }

    const workerRun = runWorkerTick({
      settingsStore,
      workerIdentityStore,
      computeClient,
      provider,
      RTCPeerConnection,
      clock,
      historyStore,
    })

    // Simulate the requester side: wait for the claim to land, then negotiate and send
    // a request over the DataChannel, matching what a real requester would do.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const { dataChannel } = await negotiateAsOfferer({
      computeClient,
      jobId,
      selfPubkey: requesterPubkey,
      peerPubkey: (await workerIdentityStore.getWorker()).publicKey,
      RTCPeerConnection,
    })
    const responsePromise = new Promise((resolve) => {
      dataChannel.addEventListener('message', (event) => resolve(JSON.parse(event.data)), {
        once: true,
      })
    })
    dataChannel.send(JSON.stringify({ model: 'qwen3:8b', prompt: 'hello' }))

    const [tickResult, response] = await Promise.all([workerRun, responsePromise])

    expect(tickResult.ranJob).toBe(true)
    expect(tickResult.result.ok).toBe(true)
    expect(response).toEqual({
      ok: true,
      text: 'the answer',
      usage: { promptTokens: 4, completionTokens: 2 },
    })

    const history = await historyStore.list()
    expect(history[0].type).toBe('completed')
    expect(history[0]).not.toHaveProperty('text')
  })

  it('rejects a job for a model that is not in the allowed list, without generating a receipt', async () => {
    const { clock, settingsStore, historyStore, workerIdentityStore } = await setUpWorker({
      model: 'only-this-model',
    })
    const computeClient = createFakeComputeClient()
    const RTCPeerConnection = createFakeRTCPeerConnectionClass()
    const requesterPubkey = 'r'.repeat(64)
    const jobId = 'b'.repeat(32)
    computeClient.seedPendingJob({
      job_id: jobId,
      capability: 'text.generate',
      status: 'pending',
      requester_pubkey: requesterPubkey,
    })

    const workerRun = runWorkerTick({
      settingsStore,
      workerIdentityStore,
      computeClient,
      provider: { generateText: async () => ({ ok: true, text: 'x', usage: {} }) },
      RTCPeerConnection,
      clock,
      historyStore,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    const { dataChannel } = await negotiateAsOfferer({
      computeClient,
      jobId,
      selfPubkey: requesterPubkey,
      peerPubkey: (await workerIdentityStore.getWorker()).publicKey,
      RTCPeerConnection,
    })
    dataChannel.send(JSON.stringify({ model: 'a-disallowed-model', prompt: 'hello' }))

    const tickResult = await workerRun
    expect(tickResult.result.ok).toBe(false)
    expect(tickResult.result.reason).toBe('model_not_allowed')
    const history = await historyStore.list()
    expect(history[0].type).toBe('failed')
  })
})
