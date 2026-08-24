// Worker identity lifecycle (SPEC.md §18; root AGENTS.md's compute-bridge direction):
// a separate Ed25519 keypair that the owner's main identity delegates a bounded set of
// `capabilities` to, so a compute worker never needs the owner's private key. Mirrors
// keys.js's shape and the same injected storage/clock ports — a host that already wires
// keys.js up gets this for free.
//
// The delegation itself is signed by the *owner's* key, which this module never stores
// or even receives as a persistent value: `authorize()` takes the owner's private key
// as a one-shot parameter, signs, and lets it go out of scope. Only the worker's own
// keypair and the resulting (owner-signed, worker-verifiable) delegation are persisted.

import {
  generateKeyPair,
  generateAuthorizationId,
  signDelegation,
  signRevocation,
  verifyDelegation,
} from '@elseweb/protocol'

const STORAGE_KEY = 'elseweb.worker-identity'
const DEFAULT_DELEGATION_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

export function createWorkerIdentityStore({ storage, clock }) {
  if (!storage || typeof storage.get !== 'function') {
    throw new TypeError('createWorkerIdentityStore requires an injected storage port')
  }
  if (!clock || typeof clock.now !== 'function') {
    throw new TypeError('createWorkerIdentityStore requires an injected clock port')
  }

  async function getWorker() {
    const record = await storage.get(STORAGE_KEY)
    return record ?? null
  }

  // Generates the worker's own keypair only — no delegation yet. Kept separate from
  // authorize() so a caller can inspect worker_pubkey (e.g. to show it in the UI)
  // before the owner ever signs anything.
  async function createWorker() {
    const pair = await generateKeyPair()
    const record = {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      delegation: null,
      createdAt: clock.now(),
    }
    await storage.set(STORAGE_KEY, record)
    return record
  }

  async function ensureWorker() {
    const existing = await getWorker()
    if (existing) return existing
    return createWorker()
  }

  // Signs a fresh delegation authorizing this worker's existing keypair, using the
  // owner's private key passed in for this one call only (root AGENTS.md non-negotiable
  // 5: the owner's key never leaves the device the caller runs this on, and this
  // function never persists it). Replaces any previously stored delegation — rotation
  // is just calling this again after createWorker() (see rotateWorker() below) or with
  // a fresh capability set for the same worker key.
  async function authorize({ ownerPrivateKey, ownerPubkey, capabilities, expiresInSeconds }) {
    const worker = await getWorker()
    if (!worker) {
      throw new Error('no worker identity to authorize — call createWorker() first')
    }
    const unsigned = {
      v: 1,
      type: 'worker-delegation',
      authorization_id: generateAuthorizationId(),
      owner_pubkey: ownerPubkey,
      worker_pubkey: worker.publicKey,
      capabilities,
      issued_at: clock.now(),
      expires_at: clock.now() + (expiresInSeconds ?? DEFAULT_DELEGATION_TTL_SECONDS),
    }
    const delegation = await signDelegation(unsigned, ownerPrivateKey)
    const updated = { ...worker, delegation }
    await storage.set(STORAGE_KEY, updated)
    return updated
  }

  // A stored delegation can be expired, missing, or otherwise no longer valid; this is
  // the single place a caller checks "is this worker currently allowed to advertise and
  // accept jobs" rather than re-deriving that logic per call site.
  async function currentDelegation({ requiredCapability, revokedIds } = {}) {
    const worker = await getWorker()
    if (!worker?.delegation) return { valid: false, reason: 'no_delegation', delegation: null }
    const result = await verifyDelegation(worker.delegation, {
      now: clock.now(),
      revokedIds,
      requiredCapability,
    })
    return { ...result, delegation: worker.delegation }
  }

  // Rotation is generating a brand-new worker keypair and discarding the old
  // delegation with it — the caller still has to get the new worker_pubkey
  // re-authorized by the owner via authorize(). The old delegation is left for the
  // owner to revoke separately (see buildRevocation below); this module has no
  // authority to revoke on the owner's behalf.
  async function rotateWorker() {
    return createWorker()
  }

  async function clearWorker() {
    await storage.remove(STORAGE_KEY)
  }

  // Builds and signs a revocation for the *currently stored* delegation's
  // authorization_id, using the owner's private key passed in for this call only, same
  // discipline as authorize(). Does not clear the local worker record — revoking is an
  // owner-side, network-visible act; the worker stopping locally is a separate decision
  // the caller makes with clearWorker() or rotateWorker().
  async function revokeCurrentDelegation({ ownerPrivateKey, ownerPubkey }) {
    const worker = await getWorker()
    if (!worker?.delegation) {
      throw new Error('no delegation to revoke')
    }
    const unsigned = {
      v: 1,
      type: 'worker-revocation',
      authorization_id: worker.delegation.authorization_id,
      owner_pubkey: ownerPubkey,
      revoked_at: clock.now(),
    }
    return signRevocation(unsigned, ownerPrivateKey)
  }

  return {
    getWorker,
    createWorker,
    ensureWorker,
    authorize,
    currentDelegation,
    rotateWorker,
    clearWorker,
    revokeCurrentDelegation,
  }
}
