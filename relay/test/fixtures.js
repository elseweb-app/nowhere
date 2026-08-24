// Shared test fixtures: a relay config with small, fast-to-mine numbers, a fake clock,
// and builders for schema-valid, correctly mined-and-signed events and attestations —
// so individual tests stay about relay behavior rather than event plumbing.

import {
  deriveTarget,
  generateKeyPair,
  mine,
  signEvent,
  canonicalizeAttestation,
  sha256,
  sign,
  buildWorkProof,
  mineWorkProof,
  generateAuthorizationId,
  signDelegation,
  signRevocation,
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

// Difficulty stays tiny (well under a byte of zero bits) so tests mine in
// milliseconds. Absolute numbers are irrelevant to what is being tested — only their
// relative ordering (e.g. "too low to satisfy the baseline tier") ever matters.
export function makeTestConfig(overrides = {}) {
  return {
    protocolVersions: [1],
    kinds: ['share', 'reply', 'vote'],
    freshnessWindowSeconds: 300,
    maxPayloadBytes: 100_000,
    quotaWindowSeconds: 86400,
    pow: {
      maxDifficulty: 24,
      challengeRequired: false,
      tiers: [
        {
          minAgeSeconds: 0,
          difficulty: { share: 4, reply: 4, vote: 2 },
          quota: { perKeyPerDay: 5, perKeyPerPagePerDay: 2, perKeyPerDayByKind: { vote: 10 } },
        },
        {
          minAgeSeconds: 604_800,
          difficulty: { share: 1, reply: 1, vote: 0 },
          quota: { perKeyPerDay: 50, perKeyPerPagePerDay: 10, perKeyPerDayByKind: { vote: 100 } },
        },
      ],
      ...overrides.pow,
    },
    attestations: {
      requiredFor: [],
      trustedIssuers: [],
      feedRequires: ['membership'],
      ...overrides.attestations,
    },
    listing: { maxEvents: 20, maxPerAuthor: 3, candidatePoolSize: 100, ...overrides.listing },
    feed: { maxEvents: 20, maxPerAuthor: 3, candidatePoolSize: 100, ...overrides.feed },
    compute: {
      jobAdmissionDifficulty: 4,
      jobTtlSeconds: 120,
      freshnessWindowSeconds: 300,
      listingLimit: 50,
      ...overrides.compute,
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => !['pow', 'attestations', 'listing', 'feed', 'compute'].includes(key)
      )
    ),
  }
}

export async function makeAuthor() {
  const { privateKey, publicKey } = await generateKeyPair()
  return { privateKey, pubkey: publicKey }
}

export async function buildSignedShareEvent({
  privateKey,
  pubkey,
  now,
  difficulty = 4,
  pageUrl = 'https://example.com/thread/1',
  text = 'hello',
  attestations = [],
  overrides = {},
}) {
  const target = await deriveTarget(pageUrl)
  const draft = {
    v: 1,
    kind: 'share',
    pubkey,
    created_at: now,
    identity_mode: 'persistent',
    attestations,
    page_id: target.page_id,
    page_url: target.page_url,
    content: { text },
    ...overrides,
  }
  const mined = await mine(draft, difficulty)
  return signEvent(mined, privateKey)
}

export async function buildSignedVoteEvent({
  privateKey,
  pubkey,
  now,
  targetId,
  value = 1,
  difficulty = 2,
  attestations = [],
  overrides = {},
}) {
  const draft = {
    v: 1,
    kind: 'vote',
    pubkey,
    created_at: now,
    identity_mode: 'persistent',
    attestations,
    target_id: targetId,
    content: { value },
    ...overrides,
  }
  const mined = await mine(draft, difficulty)
  return signEvent(mined, privateKey)
}

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

export async function buildMinedWorkProof({ subject, resource, now, difficulty = 4 }) {
  const draft = buildWorkProof({ purpose: 'compute-admission', subject, resource, createdAt: now })
  return mineWorkProof(draft, difficulty)
}

export async function buildSignedDelegation({
  ownerPrivateKey,
  ownerPubkey,
  workerPubkey,
  capabilities,
  issuedAt,
  expiresAt,
}) {
  const unsigned = {
    v: 1,
    type: 'worker-delegation',
    authorization_id: generateAuthorizationId(),
    owner_pubkey: ownerPubkey,
    worker_pubkey: workerPubkey,
    capabilities,
    issued_at: issuedAt,
    expires_at: expiresAt,
  }
  return signDelegation(unsigned, ownerPrivateKey)
}

export async function buildSignedRevocation({
  ownerPrivateKey,
  ownerPubkey,
  authorizationId,
  revokedAt,
}) {
  const unsigned = {
    v: 1,
    type: 'worker-revocation',
    authorization_id: authorizationId,
    owner_pubkey: ownerPubkey,
    revoked_at: revokedAt,
  }
  return signRevocation(unsigned, ownerPrivateKey)
}

// A store whose every method throws if called. Used to prove that a rejection at a
// given verification step made zero storage calls — if it had, the throw below would
// surface as a rejected assertion, not a clean typed rejection.
export function createPoisonedStore() {
  const poison = (methodName) => () => {
    throw new Error(`storage port method "${methodName}" must not be called before step 11`)
  }
  return {
    putEvent: poison('putEvent'),
    eventsByPage: poison('eventsByPage'),
    votesByTarget: poison('votesByTarget'),
    feedPage: poison('feedPage'),
    keyRecord: poison('keyRecord'),
    bumpQuota: poison('bumpQuota'),
    quotaUsage: poison('quotaUsage'),
  }
}
