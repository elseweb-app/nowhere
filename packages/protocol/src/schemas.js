import * as v from 'valibot'

const hex64 = () => v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))
const hex128 = () => v.pipe(v.string(), v.regex(/^[0-9a-f]{128}$/))
// 16 bytes / 128 bits hex-encoded. Used for one-time nonces, authorization ids, and
// job ids — anywhere the spec asks for "at least 128 bits of entropy" without also
// needing the full 256-bit width a pubkey or digest carries.
const hex32 = () => v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/))
const integer = () => v.pipe(v.number(), v.integer())

// Only http and https targets exist; anything else was never normalizable (SPEC.md §6.1).
const targetUrl = () => v.pipe(v.string(), v.regex(/^https?:\/\/./))

// A generic, open "area.verb" namespace (SPEC.md §19) — never a closed enum, so a new
// capability name never requires a protocol version bump. Deliberately excludes any
// runtime or provider name (Ollama, WebGPU, ...); those aren't protocol concepts.
const capabilityName = () => v.pipe(v.string(), v.regex(/^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/))

const IssuerSignedAttestation = v.strictObject({
  type: v.literal('issuer-signed'),
  issuer: hex64(),
  claim: v.string(),
  subject: hex64(),
  issued_at: integer(),
  expires_at: integer(),
  sig: hex128(),
})

// A type this version does not speak still has to parse, or adding an attestation type
// later would be a breaking change (SPEC.md §8). Unknown types are carried through here
// and ignored at verification — parsing is not where that decision belongs.
const UnknownAttestation = v.pipe(
  v.object({ type: v.string() }),
  v.check((attestation) => attestation.type !== 'issuer-signed', 'malformed issuer-signed')
)

export const AttestationSchema = v.union([IssuerSignedAttestation, UnknownAttestation])

const envelopeFields = {
  v: v.literal(1),
  pubkey: hex64(),
  created_at: integer(),
  identity_mode: v.picklist(['persistent', 'ephemeral']),
  nonce: integer(),
  attestations: v.array(AttestationSchema),
  id: hex64(),
  sig: hex128(),
}

// strictObject throughout: a field that belongs to another kind must be rejected, not
// quietly ignored, or a share carrying parent_id would canonicalize to bytes no verifier
// agreed to. `media` is reserved in v1 and is refused for the same reason.
const textContent = v.strictObject({ text: v.string() })

const anchor = v.strictObject({ id: v.string() })

const ShareSchema = v.strictObject({
  ...envelopeFields,
  kind: v.literal('share'),
  page_id: hex64(),
  page_url: targetUrl(),
  anchor: v.optional(anchor),
  content: textContent,
})

const ReplySchema = v.strictObject({
  ...envelopeFields,
  kind: v.literal('reply'),
  page_id: hex64(),
  page_url: targetUrl(),
  parent_id: hex64(),
  root_id: hex64(),
  anchor: v.optional(anchor),
  content: textContent,
})

const VoteSchema = v.strictObject({
  ...envelopeFields,
  kind: v.literal('vote'),
  target_id: hex64(),
  content: v.strictObject({ value: v.picklist([1, -1]) }),
})

export const EventSchema = v.variant('kind', [ShareSchema, ReplySchema, VoteSchema])

// Deliberately not strict. A relay may advertise capabilities this client has never heard
// of, and refusing to read its policy over an unknown field would be the client's bug.
// `looseObject` rather than `object` because valibot's `object` strips what it does not
// recognize: a v2 field would survive validation and then quietly vanish before any
// caller could see it, which is a worse failure than rejecting it outright.
export const PolicySchema = v.looseObject({
  protocol_versions: v.array(integer()),
  kinds: v.array(v.string()),
  pow: v.optional(
    v.looseObject({
      default_difficulty: v.optional(v.record(v.string(), integer())),
      max_difficulty: v.optional(integer()),
      challenge_required: v.optional(v.boolean()),
    })
  ),
  freshness_window_seconds: v.optional(integer()),
  max_payload_bytes: v.optional(integer()),
  attestations: v.optional(
    v.looseObject({
      required_for: v.optional(v.array(v.string())),
      trusted_issuers: v.optional(v.array(hex64())),
      feed_requires: v.optional(v.array(v.string())),
    })
  ),
  quotas: v.optional(v.record(v.string(), v.union([integer(), v.record(v.string(), integer())]))),
})

// GET /keys/{pubkey} (SPEC.md §7.3, §10): what one specific key currently must pay and
// how much quota it has left. `looseObject` throughout, same reasoning as PolicySchema —
// a relay may report a field this client has never heard of, and valibot's `object`
// would silently strip it rather than reject it, deleting a forward-compatible field
// before any caller could see it. Every field is optional: a relay may omit either.
export const KeyStatusSchema = v.looseObject({
  required_difficulty: v.optional(v.record(v.string(), integer())),
  remaining_quota: v.optional(v.record(v.string(), integer())),
})

// Proof-of-control challenge (SPEC.md §17): `subject` signs this itself, so control of
// the pubkey IS the signature — there is no separate issuer role like an attestation has.
export const ProofOfControlChallengeSchema = v.strictObject({
  v: v.literal(1),
  type: v.literal('proof-of-control'),
  action: v.string(),
  audience: v.string(),
  subject: hex64(),
  resource: v.string(),
  nonce: hex32(),
  issued_at: integer(),
  expires_at: integer(),
  sig: hex128(),
})

// Worker/device delegation (SPEC.md §18): `owner_pubkey` authorizes `worker_pubkey` to
// act with `capabilities` on its behalf. `owner_pubkey === worker_pubkey` is refused at
// parse time — a delegation authorizing a key to act as itself is meaningless and would
// otherwise slip past `verifyDelegation`'s `self_delegation` check for any caller that
// skips schema validation.
export const WorkerDelegationSchema = v.pipe(
  v.strictObject({
    v: v.literal(1),
    type: v.literal('worker-delegation'),
    authorization_id: hex32(),
    owner_pubkey: hex64(),
    worker_pubkey: hex64(),
    capabilities: v.array(capabilityName()),
    issued_at: integer(),
    expires_at: integer(),
    sig: hex128(),
  }),
  v.check((delegation) => delegation.owner_pubkey !== delegation.worker_pubkey, 'self-delegation')
)

// A revocation is its own small signed object (SPEC.md §18.1), not a field on the
// delegation, because the owner must be able to revoke without needing the original
// delegation object at hand — only the `authorization_id` it named.
export const WorkerRevocationSchema = v.strictObject({
  v: v.literal(1),
  type: v.literal('worker-revocation'),
  authorization_id: hex32(),
  owner_pubkey: hex64(),
  revoked_at: integer(),
  sig: hex128(),
})

// Generic metering, never pricing: a unit string and an integer amount. What a unit is
// worth is entirely a consumer's business (SPEC.md §19).
const usage = v.strictObject({ unit: v.string(), amount: integer() })

// Compute receipt (SPEC.md §19): the worker signs first (`worker_sig`, over every field
// except the two signatures); the requester MAY countersign afterward (`requester_sig`,
// over every field including `worker_sig`), which is what lets a verifier tell "the
// worker claims it finished" apart from "the requester confirms it received the result".
// `result_hash` is a digest, never the result itself — nothing here carries job content.
export const ComputeReceiptSchema = v.strictObject({
  v: v.literal(1),
  type: v.literal('compute-receipt'),
  job_id: hex32(),
  requester_pubkey: hex64(),
  worker_pubkey: hex64(),
  capability: capabilityName(),
  usage,
  result_hash: hex64(),
  started_at: integer(),
  finished_at: integer(),
  worker_sig: hex128(),
  requester_sig: v.optional(hex128()),
})

// Generic admission-control work proof (SPEC.md §20): deliberately shaped with no `sig`
// field so `pow.js`'s existing `mine`/`hasSufficientWork` — which only strip `id` and an
// optional `sig` before hashing — work on it unmodified. `resource` binds one proof to
// one specific request; without it a single mined proof would be replayable across every
// request the same `subject` makes inside the freshness window.
export const WorkProofSchema = v.strictObject({
  v: v.literal(1),
  type: v.literal('work-proof'),
  purpose: v.string(),
  subject: hex64(),
  resource: v.string(),
  created_at: integer(),
  nonce: integer(),
  id: hex64(),
})

const rejectionCodes = [
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_KIND',
  'SCHEMA_INVALID',
  'PAYLOAD_TOO_LARGE',
  'STALE_TIMESTAMP',
  'SIGNATURE_INVALID',
  'ATTESTATION_INVALID',
  'ATTESTATION_REQUIRED',
  'POW_INSUFFICIENT',
  'QUOTA_EXCEEDED',
]

// Each code carries its own extra fields (SPEC.md section 16), so this stays open past
// code and message. It must be `looseObject`, not `object`: valibot's `object` does not
// reject an unknown key, it *strips* it, which would silently delete the
// `required_difficulty` a client needs in order to re-mine.
export const ErrorEnvelopeSchema = v.looseObject({
  error: v.looseObject({
    code: v.picklist(rejectionCodes),
    message: v.string(),
  }),
})

export { ShareSchema, ReplySchema, VoteSchema }

export const parseEvent = (value) => v.parse(EventSchema, value)
export const safeParseEvent = (value) => v.safeParse(EventSchema, value)
export const safeParsePolicy = (value) => v.safeParse(PolicySchema, value)
export const safeParseErrorEnvelope = (value) => v.safeParse(ErrorEnvelopeSchema, value)
export const safeParseAttestation = (value) => v.safeParse(AttestationSchema, value)
export const safeParseKeyStatus = (value) => v.safeParse(KeyStatusSchema, value)
export const safeParseChallenge = (value) => v.safeParse(ProofOfControlChallengeSchema, value)
export const safeParseDelegation = (value) => v.safeParse(WorkerDelegationSchema, value)
export const safeParseRevocation = (value) => v.safeParse(WorkerRevocationSchema, value)
export const safeParseReceipt = (value) => v.safeParse(ComputeReceiptSchema, value)
export const safeParseWorkProof = (value) => v.safeParse(WorkProofSchema, value)
