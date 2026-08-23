// A real HTTP server in front of the relay core, for tests that need to prove the whole
// path rather than call a handler directly. The core speaks Web-standard Request and
// Response so it runs unchanged on Deno; this bridges those to node:http so vitest can
// exercise it over an actual socket, with no Docker and no Supabase account.
//
// This file is test scaffolding, not a second relay implementation. It parses no
// protocol, makes no decisions, and must never grow one — everything that matters
// happens inside relay/src.

import { createServer } from 'node:http'

function toWebRequest(nodeRequest, origin) {
  const url = new URL(nodeRequest.url, origin)
  const headers = new Headers()
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }

  const hasBody = nodeRequest.method !== 'GET' && nodeRequest.method !== 'HEAD'
  if (!hasBody) {
    return new Request(url, { method: nodeRequest.method, headers })
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    nodeRequest.on('data', (chunk) => chunks.push(chunk))
    nodeRequest.on('error', reject)
    nodeRequest.on('end', () => {
      resolve(
        new Request(url, { method: nodeRequest.method, headers, body: Buffer.concat(chunks) })
      )
    })
  })
}

async function writeWebResponse(webResponse, nodeResponse) {
  const headers = {}
  webResponse.headers.forEach((value, name) => {
    headers[name] = value
  })
  const body = Buffer.from(await webResponse.arrayBuffer())
  nodeResponse.writeHead(webResponse.status, headers)
  nodeResponse.end(body)
}

// Starts on an ephemeral port so several relays can run at once in the same test — which
// is the only way to exercise the multi-relay behavior SPEC.md section 12 requires.
export async function startRelayServer(app) {
  const server = createServer((nodeRequest, nodeResponse) => {
    const origin = `http://${nodeRequest.headers.host ?? '127.0.0.1'}`
    Promise.resolve(toWebRequest(nodeRequest, origin))
      .then((request) => app.handle(request))
      .then((response) => writeWebResponse(response, nodeResponse))
      .catch((cause) => {
        // A throw escaping the core is a bug in the core, never a protocol rejection —
        // rejections are values. Surfacing it as a plain 500 keeps the test honest: it
        // will fail on the missing event rather than quietly retrying.
        nodeResponse.writeHead(500, { 'content-type': 'text/plain' })
        nodeResponse.end(String(cause?.stack ?? cause))
      })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
