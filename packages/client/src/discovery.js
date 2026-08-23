// What a relay says about itself: its policy document (SPEC.md section 11) and what one
// key currently owes (section 10, `GET /keys/{pubkey}`). Separated from relay.js because
// these are read on a different schedule from ordinary traffic — cached, consulted before
// mining, and refreshed rarely — and because keeping the caching state in one small module
// makes it obvious there is exactly one cache per relay.

import { safeParsePolicy, safeParseKeyStatus } from '@elseweb/protocol'

const DEFAULT_POLICY_TTL_SECONDS = 300

export function createDiscovery({
  url,
  endpoint,
  fetch: fetchImplementation,
  clock,
  policyTtlSeconds = DEFAULT_POLICY_TTL_SECONDS,
}) {
  let cachedPolicy = null
  let cachedPolicyExpiresAt = -Infinity

  // Throws rather than returning a typed failure, and deliberately so: a policy is what
  // the client mines and validates against, so continuing without one would mean guessing
  // the relay's rules. The pool catches this and excludes the relay from the broadcast;
  // no caller is expected to proceed on a policy it could not read.
  async function getPolicy({ forceRefresh = false } = {}) {
    if (!forceRefresh && cachedPolicy && clock.now() < cachedPolicyExpiresAt) {
      return cachedPolicy
    }

    const response = await fetchImplementation(endpoint('/policy'))
    if (!response.ok) {
      throw new Error(`relay ${url} refused to serve its policy: HTTP ${response.status}`)
    }
    const body = await response.json()
    const parsed = safeParsePolicy(body)
    if (!parsed.success) {
      throw new Error(`relay ${url} returned a policy that does not match the schema`)
    }

    cachedPolicy = parsed.output
    cachedPolicyExpiresAt = clock.now() + policyTtlSeconds
    return cachedPolicy
  }

  function unavailable(message) {
    return { relay: url, ok: false, message }
  }

  // SPEC.md sections 7.3 and 10: what this one key currently must pay and how much quota
  // it has left. Unlike the policy this is an optimization — a client that cannot read it
  // still publishes correctly using the policy's default difficulty and recovers from a
  // POW_INSUFFICIENT in one retry. So it reports failure instead of raising, and every
  // step that could throw is guarded, including decoding a body that turns out not to be
  // JSON at all.
  async function getKeyStatus(pubkey) {
    let response
    try {
      response = await fetchImplementation(endpoint(`/keys/${pubkey}`))
    } catch (cause) {
      return unavailable(String(cause?.message ?? cause))
    }
    if (!response.ok) {
      return unavailable(`relay ${url} refused key status: HTTP ${response.status}`)
    }

    let body
    try {
      body = await response.json()
    } catch {
      return unavailable(`relay ${url} returned key status that is not JSON`)
    }

    const parsed = safeParseKeyStatus(body)
    if (!parsed.success) {
      return unavailable(`relay ${url} returned a key status that does not match the schema`)
    }
    return { relay: url, ok: true, ...parsed.output }
  }

  return { getPolicy, getKeyStatus }
}
