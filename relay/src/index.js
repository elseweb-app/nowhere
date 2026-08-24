// createRelayApp wires an injected storage port, config and clock into a router. This
// is the one function a host binding (a Supabase edge function, a bare Node/Deno HTTP
// server, a test harness) needs to call — see policy.js for the config shape this
// relay expects.

import { assertStorePort } from './store.js'
import { assertComputeStorePort } from './compute-store.js'
import { routeRequest } from './router.js'

// `computeStore` is optional: a binding that has not opted into the compute-transport
// endpoints (root AGENTS.md's compute-bridge direction) can omit it and every
// /compute/* route 404s via routeRequest's fallback, same as any other unrouted path.
export function createRelayApp({ store, config, clock, computeStore }) {
  assertStorePort(store)
  if (computeStore !== undefined) {
    assertComputeStorePort(computeStore)
  }
  if (!config) {
    throw new TypeError('createRelayApp requires a config object')
  }
  if (!clock || typeof clock.now !== 'function') {
    throw new TypeError('createRelayApp requires an injected clock port with a now() method')
  }

  async function handle(request) {
    return routeRequest(request, { store, config, clock, computeStore })
  }

  return { handle }
}

export { assertStorePort } from './store.js'
export { assertComputeStorePort } from './compute-store.js'
export { buildPolicy, keyStatus, resolveTier } from './policy.js'
