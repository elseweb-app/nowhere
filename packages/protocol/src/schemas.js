import * as v from 'valibot'

const hex64 = () => v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))
const hex128 = () => v.pipe(v.string(), v.regex(/^[0-9a-f]{128}$/))
const integer = () => v.pipe(v.number(), v.integer())

// Only http and https targets exist; anything else was never normalizable (SPEC.md §6.1).
const targetUrl = () => v.pipe(v.string(), v.regex(/^https?:\/\/./))

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
export const PolicySchema = v.object({
  protocol_versions: v.array(integer()),
  kinds: v.array(v.string()),
  pow: v.optional(
    v.object({
      default_difficulty: v.optional(v.record(v.string(), integer())),
      max_difficulty: v.optional(integer()),
      challenge_required: v.optional(v.boolean()),
    })
  ),
  freshness_window_seconds: v.optional(integer()),
  max_payload_bytes: v.optional(integer()),
  attestations: v.optional(
    v.object({
      required_for: v.optional(v.array(v.string())),
      trusted_issuers: v.optional(v.array(hex64())),
      feed_requires: v.optional(v.array(v.string())),
    })
  ),
  quotas: v.optional(v.record(v.string(), v.union([integer(), v.record(v.string(), integer())]))),
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

// Each code carries its own extra fields, so this stays open past code and message.
export const ErrorEnvelopeSchema = v.object({
  error: v.object({
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
