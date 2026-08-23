// Shared test fixtures: a fake clock and storage port (standing in for the platform
// ports this package takes as arguments), a stub fetch router (standing in for the one
// global this package is allowed to touch), and small builders for schema-valid events
// so individual tests can stay about behavior rather than event plumbing.

import {
  deriveTarget,
  signEvent,
  generateKeyPair,
  canonicalizeAttestation,
  sha256,
  sign,
} from '@elseweb/protocol'

export function createFakeClock(startSeconds = 1_700_000_000) {
  let current = startSeconds
  return {
    now: () => current,
    advance(seconds) {
      current += seconds
    },
  }
}

export function createFakeStorage() {
  const store = new Map()
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : undefined
    },
    async set(key, value) {
      store.set(key, value)
    },
    async remove(key) {
      store.delete(key)
    },
  }
}

export function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

export function makePolicy(overrides = {}) {
  return {
    protocol_versions: [1],
    kinds: ['share', 'reply', 'vote'],
    pow: {
      default_difficulty: { share: 0, reply: 0, vote: 0 },
      max_difficulty: 24,
      challenge_required: false,
    },
    freshness_window_seconds: 300,
    max_payload_bytes: 8192,
    attestations: { required_for: [], trusted_issuers: [], feed_requires: [] },
    quotas: { per_key_per_day: 50 },
    ...overrides,
  }
}

// A router in front of one relay's endpoints, so a test describes behavior ("what does
// this relay say to a publish") instead of URL parsing. `onPublish`/`onQuery` receive
// already-decoded input and return a response built with jsonResponse.
export function makeStubFetch({ policy, onPublish, onQuery } = {}) {
  return async function stubFetch(url, options = {}) {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/policy')) {
      return jsonResponse(policy ?? makePolicy())
    }
    if (parsed.pathname.endsWith('/events') && options.method === 'POST') {
      const event = JSON.parse(options.body)
      return onPublish(event)
    }
    if (parsed.pathname.endsWith('/events') || parsed.pathname.endsWith('/feed')) {
      return onQuery(parsed.searchParams)
    }
    throw new Error(`unhandled stub request: ${url}`)
  }
}

// Returns the keypair under the names the event builders destructure. generateKeyPair()
// calls it `publicKey`; on the wire and in every schema the field is `pubkey`, and a
// helper that hands back the other spelling silently builds events with no author.
export async function makeAuthor() {
  const { privateKey, publicKey } = await generateKeyPair()
  return { privateKey, pubkey: publicKey }
}

// The kind-shaped draft pool.publish() expects: everything but id/sig/nonce, which
// mining and signing fill in. Kept separate from makeShareEvent so a test that only
// needs an unsigned draft never has to sign something and then strip the signature back
// off again.
export async function makeShareDraft({
  pubkey,
  now,
  pageUrl = 'https://example.com/',
  text = 'hello',
}) {
  const target = await deriveTarget(pageUrl)
  return {
    v: 1,
    kind: 'share',
    pubkey,
    created_at: now,
    identity_mode: 'persistent',
    attestations: [],
    page_id: target.page_id,
    page_url: target.page_url,
    content: { text },
  }
}

export async function makeShareEvent({
  privateKey,
  pubkey,
  now,
  pageUrl = 'https://example.com/',
  text = 'hello',
  attestations = [],
  identityMode = 'persistent',
}) {
  const target = await deriveTarget(pageUrl)
  const draft = {
    v: 1,
    kind: 'share',
    pubkey,
    created_at: now,
    identity_mode: identityMode,
    nonce: 0,
    attestations,
    page_id: target.page_id,
    page_url: target.page_url,
    content: { text },
  }
  return signEvent(draft, privateKey)
}

// A real, correctly signed `issuer-signed` attestation (SPEC.md section 8.1), built
// from a freshly generated issuer keypair rather than a fixture, so a test can freely
// choose which issuer is or isn't in a trusted-issuer list.
export async function makeAttestation({
  issuerPrivateKey,
  issuerPubkey,
  subject,
  issuedAt,
  expiresAt,
  claim = 'membership',
}) {
  const unsigned = {
    type: 'issuer-signed',
    issuer: issuerPubkey,
    claim,
    subject,
    issued_at: issuedAt,
    expires_at: expiresAt,
  }
  const digest = await sha256(new TextEncoder().encode(canonicalizeAttestation(unsigned)))
  const sig = await sign(issuerPrivateKey, digest)
  return { ...unsigned, sig }
}

export async function makeVoteEvent({ privateKey, pubkey, now, targetId, value }) {
  const draft = {
    v: 1,
    kind: 'vote',
    pubkey,
    created_at: now,
    identity_mode: 'persistent',
    nonce: 0,
    attestations: [],
    target_id: targetId,
    content: { value },
  }
  return signEvent(draft, privateKey)
}
