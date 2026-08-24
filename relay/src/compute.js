// Compute-transport handlers, per root AGENTS.md's compute-bridge direction and
// packages/protocol/SPEC.md §17-21. One function per endpoint, same pure
// decoded-input-plus-deps-in / `{ status, body }`-out discipline as handlers.js.
//
// What this module deliberately does NOT do: it never carries a job's prompt or
// result. A job here is admission + routing metadata only (SPEC.md §20's public
// surface); the prompt/result payload travels peer-to-peer between requester and
// worker over WebRTC, using the `signal` mailbox below only to exchange SDP/ICE —
// never plaintext job content. `putEvent`/the permanent event store in store.js is
// never touched from here.
//
// Revocation is enforced honestly: a delegation is only ever treated as revoked when
// this relay has actually stored a valid `worker-revocation` object for its
// `authorization_id` (via submitRevocation below) — there is no unstated assumption of
// a revocation list this relay doesn't actually hold.

import {
  safeParseWorkProof,
  verifyWorkProof,
  safeParseDelegation,
  verifyDelegation,
  safeParseReceipt,
  verifyReceipt,
  safeParseRevocation,
  verifyRevocation,
} from '@elseweb/protocol'
import { computeError, statusForComputeCode } from './compute-errors.js'

const JOB_ID_BYTES_HEX_LENGTH = 32 // 16 bytes hex, matching hex32() in schemas.js

function invalid(code, message, extra) {
  const error = computeError(code, message, extra)
  return { status: statusForComputeCode(code), body: error }
}

function isJobExpired(job, now) {
  return now >= job.expires_at
}

// POST /compute/jobs — a requester announces admission-checked intent to run
// `capability`. No prompt travels here; the requester and worker exchange it directly
// once matched (see postSignal below).
export async function handleCreateJob({ body, computeStore, config, clock }) {
  const now = clock.now()

  const workProofResult = safeParseWorkProof(body?.work_proof)
  if (!workProofResult.success) {
    return invalid('SCHEMA_INVALID', 'work_proof does not match WorkProofSchema')
  }
  if (typeof body?.requester_pubkey !== 'string' || typeof body?.capability !== 'string') {
    return invalid('SCHEMA_INVALID', 'requester_pubkey and capability are required')
  }

  const workProof = workProofResult.output
  if (workProof.subject !== body.requester_pubkey) {
    return invalid('WORK_PROOF_INVALID', 'work_proof.subject must equal requester_pubkey')
  }

  const verified = await verifyWorkProof(workProof, {
    difficulty: config.compute.jobAdmissionDifficulty,
    now,
    windowSeconds: config.compute.freshnessWindowSeconds,
  })
  if (!verified.valid) {
    return invalid('WORK_PROOF_INVALID', `work proof rejected: ${verified.reason}`)
  }

  const jobId = workProof.resource
  if (typeof jobId !== 'string' || jobId.length !== JOB_ID_BYTES_HEX_LENGTH) {
    return invalid(
      'WORK_PROOF_INVALID',
      'work_proof.resource must be the 16-byte-hex job id it admits'
    )
  }

  const existing = await computeStore.getJob(jobId)
  if (existing) {
    return invalid('SCHEMA_INVALID', 'job_id already in use')
  }

  const job = {
    job_id: jobId,
    requester_pubkey: body.requester_pubkey,
    capability: body.capability,
    status: 'pending',
    worker_pubkey: null,
    created_at: now,
    expires_at: now + config.compute.jobTtlSeconds,
    receipt: null,
  }
  await computeStore.putJob(job)
  return { status: 201, body: { job } }
}

// GET /compute/jobs?capability=text.generate — a worker polls for pending work
// offering a capability it holds a delegation for. Returns metadata only.
export async function handleListPendingJobs({ capability, computeStore, config, clock }) {
  if (typeof capability !== 'string' || capability.length === 0) {
    return invalid('SCHEMA_INVALID', 'capability query parameter is required')
  }
  const now = clock.now()
  const candidates = await computeStore.pendingJobsByCapability({
    capability,
    limit: config.compute.listingLimit,
  })
  const jobs = candidates.filter((job) => !isJobExpired(job, now))
  return { status: 200, body: { jobs } }
}

// POST /compute/jobs/{id}/claim — first valid claim wins. The worker proves it holds
// a delegation authorizing this exact capability; the relay verifies signature,
// self-delegation, revocation, expiry and capability before honoring the claim.
export async function handleClaimJob({ jobId, body, computeStore, clock }) {
  const now = clock.now()
  const job = await computeStore.getJob(jobId)
  if (!job) return invalid('JOB_NOT_FOUND', 'no job with that id')
  if (isJobExpired(job, now)) return invalid('JOB_NOT_FOUND', 'job has expired')
  if (job.status !== 'pending') return invalid('JOB_NOT_CLAIMABLE', 'job is not pending')

  const delegationResult = safeParseDelegation(body?.delegation)
  if (!delegationResult.success) {
    return invalid('SCHEMA_INVALID', 'delegation does not match WorkerDelegationSchema')
  }
  const delegation = delegationResult.output

  const revokedIds = (await computeStore.isRevoked(delegation.authorization_id))
    ? [delegation.authorization_id]
    : []
  const verified = await verifyDelegation(delegation, {
    now,
    revokedIds,
    requiredCapability: job.capability,
  })
  if (!verified.valid) {
    return invalid('DELEGATION_INVALID', `delegation rejected: ${verified.reason}`)
  }

  job.status = 'claimed'
  job.worker_pubkey = delegation.worker_pubkey
  job.claimed_at = now
  await computeStore.putJob(job)
  return { status: 200, body: { job } }
}

// GET /compute/jobs/{id} — status poll for whichever side needs to know the job
// progressed (claimed / done / failed) and, once done, its receipt.
export async function handleGetJob({ jobId, computeStore, clock }) {
  const now = clock.now()
  const job = await computeStore.getJob(jobId)
  if (!job) return invalid('JOB_NOT_FOUND', 'no job with that id')
  if (job.status === 'pending' && isJobExpired(job, now)) {
    return invalid('JOB_NOT_FOUND', 'job has expired')
  }
  return { status: 200, body: { job } }
}

// POST /compute/jobs/{id}/signal — a mailbox for WebRTC SDP offer/answer and ICE
// candidates only. `kind` is opaque to the relay; it never inspects `data` beyond
// forwarding it. This is intentionally the only place a job's two parties exchange
// anything after claim — everything else here is metadata.
export async function handlePostSignal({ jobId, body, computeStore, clock }) {
  const now = clock.now()
  const job = await computeStore.getJob(jobId)
  if (!job) return invalid('JOB_NOT_FOUND', 'no job with that id')
  if (job.status !== 'claimed' && job.status !== 'pending') {
    return invalid('JOB_NOT_CLAIMABLE', 'job is not open for signaling')
  }
  if (typeof body?.from_pubkey !== 'string' || typeof body?.kind !== 'string' || !body?.data) {
    return invalid('SCHEMA_INVALID', 'from_pubkey, kind and data are required')
  }
  if (body.from_pubkey !== job.requester_pubkey && body.from_pubkey !== job.worker_pubkey) {
    return invalid('SCHEMA_INVALID', "from_pubkey must be this job's requester or worker")
  }

  const index = await computeStore.appendSignal(jobId, {
    from_pubkey: body.from_pubkey,
    kind: body.kind,
    data: body.data,
    at: now,
  })
  return { status: 201, body: { index } }
}

// GET /compute/jobs/{id}/signal?since=-1 — the other party polls for messages it
// hasn't seen yet.
export async function handleListSignals({ jobId, since, computeStore }) {
  const job = await computeStore.getJob(jobId)
  if (!job) return invalid('JOB_NOT_FOUND', 'no job with that id')
  const sinceIndex = Number.isInteger(since) ? since : -1
  const messages = await computeStore.signalsSince(jobId, sinceIndex)
  return { status: 200, body: { messages } }
}

// POST /compute/jobs/{id}/receipt — the worker posts its worker-signed
// ComputeReceiptSchema once the job finishes (successfully or not; a failed job never
// gets a receipt — see root AGENTS.md "a failed job must not generate a successful
// receipt"). This is the only place job status moves to `done`.
export async function handleSubmitReceipt({ jobId, body, computeStore, clock }) {
  const now = clock.now()
  const job = await computeStore.getJob(jobId)
  if (!job) return invalid('JOB_NOT_FOUND', 'no job with that id')
  if (job.status !== 'claimed') return invalid('JOB_NOT_CLAIMABLE', 'job is not claimed')

  const receiptResult = safeParseReceipt(body?.receipt)
  if (!receiptResult.success) {
    return invalid('RECEIPT_INVALID', 'receipt does not match ComputeReceiptSchema')
  }
  const receipt = receiptResult.output
  if (receipt.job_id !== jobId || receipt.worker_pubkey !== job.worker_pubkey) {
    return invalid('RECEIPT_INVALID', 'receipt does not match this job')
  }

  const verified = await verifyReceipt(receipt)
  if (!verified.valid) {
    return invalid('RECEIPT_INVALID', `receipt rejected: ${verified.reason}`)
  }

  job.status = 'done'
  job.receipt = receipt
  job.finished_at = now
  await computeStore.putJob(job)
  return { status: 200, body: { job } }
}

// POST /compute/jobs/{id}/countersign — the requester MAY add its countersignature to
// an already worker-signed receipt (SPEC.md §19's two-stage signing).
export async function handleCountersignReceipt({ jobId, body, computeStore }) {
  const job = await computeStore.getJob(jobId)
  if (!job) return invalid('JOB_NOT_FOUND', 'no job with that id')
  if (job.status !== 'done' || !job.receipt) {
    return invalid('JOB_NOT_CLAIMABLE', 'job has no receipt to countersign yet')
  }

  const receiptResult = safeParseReceipt(body?.receipt)
  if (!receiptResult.success) {
    return invalid('RECEIPT_INVALID', 'receipt does not match ComputeReceiptSchema')
  }
  const receipt = receiptResult.output
  if (receipt.job_id !== jobId || receipt.worker_sig !== job.receipt.worker_sig) {
    return invalid('RECEIPT_INVALID', 'countersigned receipt must match the stored worker receipt')
  }

  const verified = await verifyReceipt(receipt, { requireCountersignature: true })
  if (!verified.valid) {
    return invalid('RECEIPT_INVALID', `receipt rejected: ${verified.reason}`)
  }

  job.receipt = receipt
  await computeStore.putJob(job)
  return { status: 200, body: { job } }
}

// POST /compute/revocations — an owner revokes a worker delegation by
// `authorization_id`. Stored so future claims against that authorization_id fail
// closed (see handleClaimJob above) — this relay never treats a delegation as revoked
// on any basis other than a revocation object it actually verified and stored.
export async function handleSubmitRevocation({ body, computeStore }) {
  const revocationResult = safeParseRevocation(body)
  if (!revocationResult.success) {
    return invalid('SCHEMA_INVALID', 'body does not match WorkerRevocationSchema')
  }
  const revocation = revocationResult.output
  const verified = await verifyRevocation(revocation)
  if (!verified.valid) {
    return invalid('SCHEMA_INVALID', `revocation rejected: ${verified.reason}`)
  }

  await computeStore.putRevocation(revocation)
  return { status: 201, body: { revocation } }
}
