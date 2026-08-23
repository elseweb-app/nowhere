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
import { schemaInvalidError, statusForCode } from './errors.js'

const KEY_STATUS_PATH = /^\/keys\/([^/]+)$/

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

  return jsonResponse(404, {
    error: { code: 'NOT_FOUND', message: `no route for ${request.method} ${pathname}` },
  })
}
