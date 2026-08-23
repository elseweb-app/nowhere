// Key lifecycle (SPEC.md sections 9 and 15; root AGENTS.md non-negotiable 5): the
// keypair is the user's identity, generated extractable so it can move between the
// extension, the website and mobile, and never sent to a relay in any form.
//
// Storage is an injected port, not a platform API:
//   get(key)         -> Promise<value | undefined>
//   set(key, value)  -> Promise<void>
//   remove(key)      -> Promise<void>
// The extension backs this with chrome.storage.local, the website with something
// IndexedDB-based, mobile with Capacitor Preferences. This module never knows which.
//
// Clock is also injected: { now() } returning Unix seconds, matching every timestamp
// elsewhere in this package and in packages/protocol.

import {
  generateKeyPair,
  publicKeyFromPrivate,
  generateTransferCode,
  wrapKey,
  unwrapKey,
} from '@elseweb/protocol'

const STORAGE_KEY = 'elseweb.identity'
const DEFAULT_TRANSFER_TTL_SECONDS = 600

export function createKeyStore({ storage, clock }) {
  if (!storage || typeof storage.get !== 'function') {
    throw new TypeError('createKeyStore requires an injected storage port')
  }
  if (!clock || typeof clock.now !== 'function') {
    throw new TypeError('createKeyStore requires an injected clock port')
  }

  async function getIdentity() {
    const record = await storage.get(STORAGE_KEY)
    return record ?? null
  }

  async function createIdentity({ identityMode = 'persistent' } = {}) {
    const pair = await generateKeyPair()
    const record = {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      identityMode,
      createdAt: clock.now(),
    }
    await storage.set(STORAGE_KEY, record)
    return record
  }

  // The common entry point for a host app on startup: use whatever identity already
  // exists, or mint one. Kept separate from createIdentity so a caller that explicitly
  // wants a fresh key (e.g. "start over") is never surprised by an early return.
  async function ensureIdentity({ identityMode = 'persistent' } = {}) {
    const existing = await getIdentity()
    if (existing) return existing
    return createIdentity({ identityMode })
  }

  async function clearIdentity() {
    await storage.remove(STORAGE_KEY)
  }

  // SPEC.md section 15: the seed leaves the device only inside an encrypted envelope,
  // paired with a high-entropy client-generated code that travels separately from the
  // QR carrying the envelope. Never a short numeric PIN — see packages/client/AGENTS.md.
  async function exportForTransfer({ expiresInSeconds = DEFAULT_TRANSFER_TTL_SECONDS } = {}) {
    const identity = await getIdentity()
    if (!identity) {
      throw new Error('no identity to transfer')
    }
    const code = generateTransferCode()
    const envelope = await wrapKey({
      seed: identity.privateKey,
      code,
      expiresAt: clock.now() + expiresInSeconds,
    })
    return { envelope, code }
  }

  // Importing replaces whatever identity is currently stored on this device. A wrong
  // code or a tampered envelope fails inside unwrapKey and this simply propagates that,
  // rather than leaving a partially-written identity behind.
  async function importFromTransfer({ envelope, code, identityMode = 'persistent' }) {
    const seed = await unwrapKey({ envelope, code, now: clock.now() })
    const publicKey = await publicKeyFromPrivate(seed)
    const record = { privateKey: seed, publicKey, identityMode, createdAt: clock.now() }
    await storage.set(STORAGE_KEY, record)
    return record
  }

  return {
    getIdentity,
    createIdentity,
    ensureIdentity,
    clearIdentity,
    exportForTransfer,
    importFromTransfer,
  }
}
