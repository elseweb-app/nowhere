// Compute-transport client (SPEC.md §17-21; relay/AGENTS.md's `/compute/*` contract):
// the requester/worker sides of admission, discovery, claim, WebRTC signaling and
// receipts. Same discipline as relay.js — one relay endpoint, injected fetch and clock,
// every call returns a typed `{ ok, ... }` outcome and never throws on a network or
// relay error, so a caller (the extension's background worker, in particular) never
// needs a try/catch around a compute round trip.
//
// This module never carries a job's prompt or result — only the metadata the relay
// itself accepts (root AGENTS.md's compute-bridge direction, relay/AGENTS.md's compute
// transport section). The actual job payload is exchanged by the caller directly over
// the WebRTC connection that `postSignal`/`listSignals` negotiate; this module knows
// nothing about WebRTC itself; it only relays opaque `{ kind, data }` messages.
//
// Required admission difficulty is relay policy, the same way event proof-of-work
// difficulty is (packages/protocol/AGENTS.md's "no thresholds" rule) — this module
// takes it as a parameter rather than guessing, exactly like createMiner does for
// events. There is no discovery endpoint for it yet (no `/compute/policy`); a caller
// gets it out-of-band for now, which is a known limitation, not an oversight.

import { buildWorkProof, mineWorkProof, safeParseReceipt } from '@elseweb/protocol'

const DEFAULT_TIMEOUT_MS = 8000

function endpointFor(url, path) {
  return url.endsWith('/') ? `${url.slice(0, -1)}${path}` : `${url}${path}`
}

async function request(fetchImplementation, url, path, { method = 'GET', body, timeoutMs } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetchImplementation(endpointFor(url, path), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    let parsed = null
    try {
      parsed = await response.json()
    } catch {
      // A response with no/invalid JSON body still becomes a typed outcome below.
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: parsed?.error?.code ?? 'UNKNOWN',
        message: parsed?.error?.message ?? `request failed with HTTP ${response.status}`,
      }
    }
    return { ok: true, status: response.status, body: parsed }
  } catch (cause) {
    return { ok: false, status: 0, code: 'NETWORK_ERROR', message: String(cause?.message ?? cause) }
  } finally {
    clearTimeout(timer)
  }
}

export function createComputeClient({ url, fetch: fetchImplementation, clock, timeoutMs }) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('createComputeClient requires a url')
  }
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('createComputeClient requires an injected fetch implementation')
  }
  if (!clock || typeof clock.now !== 'function') {
    throw new TypeError('createComputeClient requires an injected clock port')
  }

  // Mines the admission work-proof and submits the job in one call, mirroring
  // publishToRelays's "mine immediately before submitting" discipline (packages/client's
  // publish.js) — a stale mined proof is never stashed and resubmitted.
  async function submitJob({ jobId, requesterPubkey, capability, difficulty, miningOptions }) {
    const draft = buildWorkProof({
      purpose: 'compute-admission',
      subject: requesterPubkey,
      resource: jobId,
      createdAt: clock.now(),
    })
    const workProof = await mineWorkProof(draft, difficulty, miningOptions)
    const result = await request(fetchImplementation, url, '/compute/jobs', {
      method: 'POST',
      body: { requester_pubkey: requesterPubkey, capability, work_proof: workProof },
      timeoutMs,
    })
    return result.ok ? { ok: true, job: result.body.job } : result
  }

  async function pollJobs({ capability }) {
    const result = await request(
      fetchImplementation,
      url,
      `/compute/jobs?capability=${encodeURIComponent(capability)}`,
      { timeoutMs }
    )
    return result.ok ? { ok: true, jobs: result.body.jobs } : { ok: false, jobs: [], ...result }
  }

  async function claimJob({ jobId, delegation }) {
    const result = await request(fetchImplementation, url, `/compute/jobs/${jobId}/claim`, {
      method: 'POST',
      body: { delegation },
      timeoutMs,
    })
    return result.ok ? { ok: true, job: result.body.job } : result
  }

  async function getJob({ jobId }) {
    const result = await request(fetchImplementation, url, `/compute/jobs/${jobId}`, { timeoutMs })
    return result.ok ? { ok: true, job: result.body.job } : result
  }

  async function postSignal({ jobId, fromPubkey, kind, data }) {
    const result = await request(fetchImplementation, url, `/compute/jobs/${jobId}/signal`, {
      method: 'POST',
      body: { from_pubkey: fromPubkey, kind, data },
      timeoutMs,
    })
    return result.ok ? { ok: true, index: result.body.index } : result
  }

  async function listSignals({ jobId, since = -1 }) {
    const result = await request(
      fetchImplementation,
      url,
      `/compute/jobs/${jobId}/signal?since=${since}`,
      { timeoutMs }
    )
    return result.ok
      ? { ok: true, messages: result.body.messages }
      : { ok: false, messages: [], ...result }
  }

  // `receipt` must already be worker-signed (signReceiptAsWorker from
  // @elseweb/protocol) — this module never signs on the caller's behalf, same as every
  // other primitive in packages/protocol.
  async function submitReceipt({ jobId, receipt }) {
    const parsed = safeParseReceipt(receipt)
    if (!parsed.success) {
      return {
        ok: false,
        status: 0,
        code: 'SCHEMA_INVALID',
        message: 'receipt is not schema-valid',
      }
    }
    const result = await request(fetchImplementation, url, `/compute/jobs/${jobId}/receipt`, {
      method: 'POST',
      body: { receipt: parsed.output },
      timeoutMs,
    })
    return result.ok ? { ok: true, job: result.body.job } : result
  }

  async function countersignReceipt({ jobId, receipt }) {
    const parsed = safeParseReceipt(receipt)
    if (!parsed.success) {
      return {
        ok: false,
        status: 0,
        code: 'SCHEMA_INVALID',
        message: 'receipt is not schema-valid',
      }
    }
    const result = await request(fetchImplementation, url, `/compute/jobs/${jobId}/countersign`, {
      method: 'POST',
      body: { receipt: parsed.output },
      timeoutMs,
    })
    return result.ok ? { ok: true, job: result.body.job } : result
  }

  async function submitRevocation(revocation) {
    const result = await request(fetchImplementation, url, '/compute/revocations', {
      method: 'POST',
      body: revocation,
      timeoutMs,
    })
    return result.ok ? { ok: true, revocation: result.body.revocation } : result
  }

  return {
    url,
    submitJob,
    pollJobs,
    claimJob,
    getJob,
    postSignal,
    listSignals,
    submitReceipt,
    countersignReceipt,
    submitRevocation,
  }
}
