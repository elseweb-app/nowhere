// The federation contract, as code. SPEC.md is normative; this package implements it.
// If the two disagree, the spec is right and this is a bug.

export {
  toHex,
  fromHex,
  sha256,
  sign,
  verify,
  generateKeyPair,
  publicKeyFromPrivate,
  randomBytes,
} from './crypto.js'

export { canonicalize, canonicalBytes } from './canonical.js'
export { computeId, signEvent, verifyEvent } from './event.js'

export { leadingZeroBits, difficultyOf, mine, hasSufficientWork, isFresh } from './pow.js'

export { normalizeUrl, deriveTarget, sameTarget } from './target.js'

export { canonicalizeAttestation, verifyAttestation } from './attestation.js'

export {
  TRANSFER_CODE_ENTROPY_BITS,
  generateTransferCode,
  wrapKey,
  unwrapKey,
} from './key-transfer.js'

export {
  EventSchema,
  ShareSchema,
  ReplySchema,
  VoteSchema,
  AttestationSchema,
  PolicySchema,
  ErrorEnvelopeSchema,
  KeyStatusSchema,
  parseEvent,
  safeParseEvent,
  safeParsePolicy,
  safeParseErrorEnvelope,
  safeParseAttestation,
  safeParseKeyStatus,
} from './schemas.js'
