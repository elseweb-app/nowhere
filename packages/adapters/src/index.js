// Adapter registry — packages/adapters/AGENTS.md.
//
// The extension never branches on which adapter it got; it only ever calls
// `adapterFor(location)` and uses the plain object that comes back, all five of whose
// functions share the identical shape across every adapter. Order matters here: every
// site-specific adapter is tried before the generic fallback, and the generic fallback
// is last because it is the only one guaranteed to match anything at all.

import { xAdapter } from './x.js'
import { genericAdapter } from './generic.js'

const registry = [xAdapter, genericAdapter]

function resolveUrl(location) {
  if (typeof location === 'string') return location
  // Accept a Location-like object (e.g. `window.location`) as well as a bare string, so
  // the caller does not have to remember to read `.href` itself before calling in.
  if (location !== null && typeof location === 'object' && typeof location.href === 'string') {
    return location.href
  }
  // Nothing usable to match against. Every site-specific adapter's matches() correctly
  // says no to this, and the generic fallback matches unconditionally, so the caller
  // still gets a usable adapter back rather than undefined.
  return ''
}

export function adapterFor(location) {
  const url = resolveUrl(location)
  for (const adapter of registry) {
    if (adapter.matches(url)) return adapter
  }
  // Unreachable while genericAdapter.matches always returns true, kept explicit so a
  // bug in a future adapter's registration fails loudly here rather than handing the
  // caller undefined and pushing the crash one call further out.
  return genericAdapter
}

export { xAdapter, genericAdapter }
