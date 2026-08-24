// Executes exactly one already-claimed job end to end: negotiate the DataChannel,
// receive the request, admit it, run the local provider, return the result, and mint
// the compute receipt (SPEC.md §19) — never the other way around. A failed job at any
// stage returns without ever calling signReceiptAsWorker, so a failed job cannot
// produce a successful receipt (root AGENTS.md's "Reliability" section).
//
// Nothing here persists a prompt or a result. `onEvent('completed', ...)` and
// `onEvent('failed', ...)` only ever carry metadata (root AGENTS.md's "Privacy"
// section) — see src/worker/history.js for what gets written to local storage.

import { sha256, toHex, signReceiptAsWorker } from '@elseweb/protocol'
import { negotiateAsAnswerer } from '@elseweb-app/client'
import { checkAdmission } from './limits.js'

function receiveOneMessage(dataChannel, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dataChannel.removeEventListener('message', onMessage)
      reject(new Error('timed out waiting for the request'))
    }, timeoutMs)
    function onMessage(event) {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(event.data))
      } catch (cause) {
        reject(cause)
      }
    }
    dataChannel.addEventListener('message', onMessage, { once: true })
  })
}

// Best-effort only: a requester disconnecting mid-response must not itself change the
// job outcome already computed above it.
function sendSafely(dataChannel, payload) {
  try {
    if (dataChannel.readyState === 'open') dataChannel.send(JSON.stringify(payload))
  } catch {
    // See comment above — deliberately swallowed.
  }
}

export async function runClaimedJob({
  job,
  computeClient,
  workerPrivateKey,
  workerPubkey,
  RTCPeerConnection,
  resolveProvider,
  allowedModels,
  limits,
  activeJobCount,
  clock,
  onEvent,
}) {
  const startedAt = clock.now()

  let dataChannel
  try {
    ;({ dataChannel } = await negotiateAsAnswerer({
      computeClient,
      jobId: job.job_id,
      selfPubkey: workerPubkey,
      peerPubkey: job.requester_pubkey,
      RTCPeerConnection,
      timeoutMs: limits.executionTimeoutMs,
    }))
  } catch (cause) {
    onEvent?.({
      type: 'failed',
      reason: 'signaling_failed',
      message: String(cause?.message ?? cause),
    })
    return { ok: false, reason: 'signaling_failed' }
  }

  let request
  try {
    request = await receiveOneMessage(dataChannel, limits.executionTimeoutMs)
  } catch (cause) {
    dataChannel.close()
    onEvent?.({ type: 'failed', reason: 'no_request', message: String(cause?.message ?? cause) })
    return { ok: false, reason: 'no_request' }
  }

  const admission = checkAdmission({
    request,
    capability: job.capability,
    allowedModels,
    limits,
    activeJobCount,
  })
  if (!admission.ok) {
    sendSafely(dataChannel, { ok: false, reason: admission.reason })
    dataChannel.close()
    onEvent?.({ type: 'failed', reason: admission.reason })
    return { ok: false, reason: admission.reason }
  }

  const provider = resolveProvider(request.model)
  if (!provider) {
    sendSafely(dataChannel, { ok: false, reason: 'model_not_allowed' })
    dataChannel.close()
    onEvent?.({ type: 'failed', reason: 'model_not_allowed' })
    return { ok: false, reason: 'model_not_allowed' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limits.executionTimeoutMs)
  let generation
  try {
    generation = await provider.generateText({
      model: request.model,
      messages: [{ role: 'user', content: request.prompt }],
      maxTokens: admission.maxTokens,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!generation.ok) {
    sendSafely(dataChannel, { ok: false, reason: 'generation_failed', message: generation.message })
    dataChannel.close()
    onEvent?.({ type: 'failed', reason: 'generation_failed', message: generation.message })
    return { ok: false, reason: 'generation_failed' }
  }

  const finishedAt = clock.now()
  sendSafely(dataChannel, { ok: true, text: generation.text, usage: generation.usage })
  dataChannel.close()

  const digest = await sha256(new TextEncoder().encode(generation.text))
  const usageAmount =
    (generation.usage.promptTokens ?? 0) + (generation.usage.completionTokens ?? 0)
  const unsignedReceipt = {
    v: 1,
    type: 'compute-receipt',
    job_id: job.job_id,
    requester_pubkey: job.requester_pubkey,
    worker_pubkey: workerPubkey,
    capability: job.capability,
    usage: { unit: 'tokens', amount: usageAmount },
    result_hash: toHex(digest),
    started_at: startedAt,
    finished_at: finishedAt,
  }
  const receipt = await signReceiptAsWorker(unsignedReceipt, workerPrivateKey)
  const submitted = await computeClient.submitReceipt({ jobId: job.job_id, receipt })
  if (!submitted.ok) {
    onEvent?.({ type: 'failed', reason: 'receipt_rejected', message: submitted.message })
    return { ok: false, reason: 'receipt_rejected' }
  }

  onEvent?.({
    type: 'completed',
    capability: job.capability,
    model: request.model,
    durationSeconds: finishedAt - startedAt,
    usage: generation.usage,
  })
  return { ok: true, receipt }
}
