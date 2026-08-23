// The public entry point. Everything below this file is reachable on its own — the
// extension will want the pool and the key store directly — but an ordinary consumer
// should never have to assemble a relay set, derive a target, mine, sign and broadcast
// by hand. It provides product data; this provides protocol mechanics.

import { createRelay } from './relay.js'
import { createRelayPool } from './pool.js'
import { createKeyStore } from './keys.js'
import { createReader } from './read.js'
import { buildShare, buildReply, buildVote } from './events.js'
import { ElsewebError } from './errors.js'

const SECONDS_PER_MILLISECOND = 1000

// The one place this package is allowed to reach for a platform default, and only for a
// clock: every runtime it targets has Date. Storage has no such universal answer, which
// is why identityStore stays required.
const systemClock = { now: () => Math.floor(Date.now() / SECONDS_PER_MILLISECOND) }

function toRelay(entry, { fetch: fetchImplementation, clock }) {
  const options = typeof entry === 'string' ? { url: entry } : entry
  return createRelay({ fetch: fetchImplementation, clock, ...options })
}

export function createElsewebClient({
  relays = [],
  identityStore,
  clock = systemClock,
  fetch: fetchImplementation = globalThis.fetch,
  trustedIssuers = [],
  canonicalizeUrl,
  limit,
  onPowProgress,
  miningOptions,
}) {
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('createElsewebClient requires a fetch implementation')
  }

  const keyStore = createKeyStore({ storage: identityStore, clock })
  const pool = createRelayPool({
    relays: relays.map((entry) => toRelay(entry, { fetch: fetchImplementation, clock })),
    clock,
  })
  const reader = createReader({ pool, clock, trustedIssuers, canonicalizeUrl, limit })

  // The seed never leaves this closure except through identity.export(), inside the
  // encrypted envelope of SPEC.md section 15. A consumer that is never handed a private
  // key cannot leak one, which is a stronger guarantee than asking it not to.
  function publicIdentity(record) {
    if (!record) return null
    return {
      publicKey: record.publicKey,
      identityMode: record.identityMode,
      createdAt: record.createdAt,
    }
  }

  async function requireIdentity() {
    const record = await keyStore.getIdentity()
    if (!record) {
      throw new ElsewebError(
        'NO_IDENTITY',
        'no identity on this device; call identity.getOrCreate() first'
      )
    }
    return record
  }

  const identity = {
    get: async () => publicIdentity(await keyStore.getIdentity()),
    getOrCreate: async (options) => publicIdentity(await keyStore.ensureIdentity(options)),
    create: async (options) => publicIdentity(await keyStore.createIdentity(options)),
    clear: () => keyStore.clearIdentity(),
    export: (options) => keyStore.exportForTransfer(options),
    import: async (options) => publicIdentity(await keyStore.importFromTransfer(options)),
  }

  async function publish(buildDraft) {
    const record = await requireIdentity()
    const draft = await buildDraft({
      identity: { publicKey: record.publicKey, identityMode: record.identityMode },
      now: clock.now(),
    })
    return pool.publish({
      event: draft,
      privateKey: record.privateKey,
      miningOptions: { onProgress: onPowProgress, ...miningOptions },
    })
  }

  return {
    identity,
    relays: {
      add: (entry) => pool.addRelay(toRelay(entry, { fetch: fetchImplementation, clock })),
      remove: (url) => pool.removeRelay(url),
      list: () =>
        pool.listRelays().map(({ url, readable, writable }) => ({ url, readable, writable })),
    },

    readPage: reader.readPage,
    readTarget: reader.readTarget,
    readVotes: reader.readVotes,
    readFeed: reader.readFeed,

    publishShare: ({ pageUrl, text, anchorId, attestations }) =>
      publish(({ identity: author, now }) =>
        buildShare({
          pageUrl,
          text,
          anchorId,
          attestations,
          identity: author,
          now,
          canonicalizeUrl,
        })
      ),

    publishReply: ({ parent, parentId, rootId, pageUrl, anchor, text, attestations }) =>
      publish(({ identity: author, now }) =>
        buildReply({
          parent,
          parentId,
          rootId,
          pageUrl,
          anchor,
          text,
          attestations,
          identity: author,
          now,
          canonicalizeUrl,
        })
      ),

    publishVote: ({ targetId, value, attestations }) =>
      publish(({ identity: author, now }) =>
        buildVote({ targetId, value, attestations, identity: author, now })
      ),
  }
}
