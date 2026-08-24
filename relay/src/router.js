// Maps method + path to a handler using only the Web-standard Request/Response
// globals, so this runs unchanged in Deno and in Node 24 — no framework, no npm HTTP
// library.

import {
  handleGetPolicy,
  handleGetKeyStatus,
  handlePublishEvent,
  handleGetEventsByPage,
  handleGetVotesByTarget,
  handleGetFeed,
} from './handlers.js'
import {
  handleCreateJob,
  handleListPendingJobs,
  handleClaimJob,
  handleGetJob,
  handlePostSignal,
  handleListSignals,
  handleSubmitReceipt,
  handleCountersignReceipt,
  handleSubmitRevocation,
} from './compute.js'
import { schemaInvalidError, statusForCode } from './errors.js'

const KEY_STATUS_PATH = /^\/keys\/([^/]+)$/
const JOB_PATH = /^\/compute\/jobs\/([^/]+)$/
const JOB_CLAIM_PATH = /^\/compute\/jobs\/([^/]+)\/claim$/
const JOB_SIGNAL_PATH = /^\/compute\/jobs\/([^/]+)\/signal$/
const JOB_RECEIPT_PATH = /^\/compute\/jobs\/([^/]+)\/receipt$/
const JOB_COUNTERSIGN_PATH = /^\/compute\/jobs\/([^/]+)\/countersign$/

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJsonBody(request) {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    const error = schemaInvalidError({ message: 'request body is not valid JSON' })
    return { ok: false, status: statusForCode(error.error.code), body: error }
  }
}

export async function routeRequest(request, deps) {
  const url = new URL(request.url)
  const { pathname, searchParams } = url

  if (request.method === 'GET' && pathname === '/policy') {
    const result = handleGetPolicy(deps)
    return jsonResponse(result.status, result.body)
  }

  const keyStatusMatch = pathname.match(KEY_STATUS_PATH)
  if (request.method === 'GET' && keyStatusMatch) {
    const result = await handleGetKeyStatus({ pubkey: keyStatusMatch[1], ...deps })
    return jsonResponse(result.status, result.body)
  }

  if (request.method === 'POST' && pathname === '/events') {
    const parsedBody = await readJsonBody(request)
    if (!parsedBody.ok) {
      return jsonResponse(parsedBody.status, parsedBody.body)
    }
    const result = await handlePublishEvent({ body: parsedBody.value, ...deps })
    return jsonResponse(result.status, result.body)
  }

  if (request.method === 'GET' && pathname === '/events') {
    const pageId = searchParams.get('page_id')
    const targetId = searchParams.get('target_id')

    if (pageId) {
      const anchorId = searchParams.get('anchor_id')
      const result = await handleGetEventsByPage({ pageId, anchorId, ...deps })
      return jsonResponse(result.status, result.body)
    }
    if (targetId) {
      const result = await handleGetVotesByTarget({ targetId, ...deps })
      return jsonResponse(result.status, result.body)
    }

    const error = schemaInvalidError({ message: 'GET /events requires page_id or target_id' })
    return jsonResponse(statusForCode(error.error.code), error)
  }

  if (request.method === 'GET' && pathname === '/feed') {
    const result = await handleGetFeed({ cursor: searchParams.get('cursor'), ...deps })
    return jsonResponse(result.status, result.body)
  }

  // Compute transport (root AGENTS.md's compute-bridge direction): admission/routing
  // metadata and WebRTC signaling only, never a job's prompt or result. Kept entirely
  // separate from the /events store above. A binding with no computeStore configured
  // never routes here at all — same 404 fallback as any other unrouted path.
  if (pathname.startsWith('/compute/') && !deps.computeStore) {
    return jsonResponse(404, {
      error: { code: 'NOT_FOUND', message: `no route for ${request.method} ${pathname}` },
    })
  }

  if (request.method === 'POST' && pathname === '/compute/jobs') {
    const parsedBody = await readJsonBody(request)
    if (!parsedBody.ok) return jsonResponse(parsedBody.status, parsedBody.body)
    const result = await handleCreateJob({ body: parsedBody.value, ...deps })
    return jsonResponse(result.status, result.body)
  }

  if (request.method === 'GET' && pathname === '/compute/jobs') {
    const result = await handleListPendingJobs({
      capability: searchParams.get('capability'),
      ...deps,
    })
    return jsonResponse(result.status, result.body)
  }

  const jobClaimMatch = pathname.match(JOB_CLAIM_PATH)
  if (request.method === 'POST' && jobClaimMatch) {
    const parsedBody = await readJsonBody(request)
    if (!parsedBody.ok) return jsonResponse(parsedBody.status, parsedBody.body)
    const result = await handleClaimJob({
      jobId: jobClaimMatch[1],
      body: parsedBody.value,
      ...deps,
    })
    return jsonResponse(result.status, result.body)
  }

  const jobSignalMatch = pathname.match(JOB_SIGNAL_PATH)
  if (request.method === 'POST' && jobSignalMatch) {
    const parsedBody = await readJsonBody(request)
    if (!parsedBody.ok) return jsonResponse(parsedBody.status, parsedBody.body)
    const result = await handlePostSignal({
      jobId: jobSignalMatch[1],
      body: parsedBody.value,
      ...deps,
    })
    return jsonResponse(result.status, result.body)
  }
  if (request.method === 'GET' && jobSignalMatch) {
    const since = searchParams.has('since') ? Number(searchParams.get('since')) : -1
    const result = await handleListSignals({ jobId: jobSignalMatch[1], since, ...deps })
    return jsonResponse(result.status, result.body)
  }

  const jobReceiptMatch = pathname.match(JOB_RECEIPT_PATH)
  if (request.method === 'POST' && jobReceiptMatch) {
    const parsedBody = await readJsonBody(request)
    if (!parsedBody.ok) return jsonResponse(parsedBody.status, parsedBody.body)
    const result = await handleSubmitReceipt({
      jobId: jobReceiptMatch[1],
      body: parsedBody.value,
      ...deps,
    })
    return jsonResponse(result.status, result.body)
  }

  const jobCountersignMatch = pathname.match(JOB_COUNTERSIGN_PATH)
  if (request.method === 'POST' && jobCountersignMatch) {
    const parsedBody = await readJsonBody(request)
    if (!parsedBody.ok) return jsonResponse(parsedBody.status, parsedBody.body)
    const result = await handleCountersignReceipt({
      jobId: jobCountersignMatch[1],
      body: parsedBody.value,
      ...deps,
    })
    return jsonResponse(result.status, result.body)
  }

  if (request.method === 'POST' && pathname === '/compute/revocations') {
    const parsedBody = await readJsonBody(request)
    if (!parsedBody.ok) return jsonResponse(parsedBody.status, parsedBody.body)
    const result = await handleSubmitRevocation({ body: parsedBody.value, ...deps })
    return jsonResponse(result.status, result.body)
  }

  const jobMatch = pathname.match(JOB_PATH)
  if (request.method === 'GET' && jobMatch) {
    const result = await handleGetJob({ jobId: jobMatch[1], ...deps })
    return jsonResponse(result.status, result.body)
  }

  return jsonResponse(404, {
    error: { code: 'NOT_FOUND', message: `no route for ${request.method} ${pathname}` },
  })
}
