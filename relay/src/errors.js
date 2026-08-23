// SPEC.md §16: every rejection is `{ error: { code, message, ...extraFields } }`, and
// each code carries exactly the extra fields the table in §16 defines for it. A bare
// 400 is not conformant — a client that cannot tell rejection reasons apart will
// either retry forever or give up on something recoverable.

const HTTP_STATUS_BY_CODE = {
  UNSUPPORTED_VERSION: 400,
  UNSUPPORTED_KIND: 400,
  SCHEMA_INVALID: 400,
  PAYLOAD_TOO_LARGE: 413,
  STALE_TIMESTAMP: 400,
  SIGNATURE_INVALID: 401,
  ATTESTATION_INVALID: 401,
  ATTESTATION_REQUIRED: 403,
  POW_INSUFFICIENT: 400,
  QUOTA_EXCEEDED: 429,
}

export function statusForCode(code) {
  return HTTP_STATUS_BY_CODE[code] ?? 400
}

function errorEnvelope(code, message, extraFields = {}) {
  return { error: { code, message, ...extraFields } }
}

export function unsupportedVersionError({ message, protocolVersions }) {
  return errorEnvelope('UNSUPPORTED_VERSION', message, { protocol_versions: protocolVersions })
}

export function unsupportedKindError({ message, kinds }) {
  return errorEnvelope('UNSUPPORTED_KIND', message, { kinds })
}

export function schemaInvalidError({ message, field }) {
  return errorEnvelope('SCHEMA_INVALID', message, { field })
}

export function payloadTooLargeError({ message, maxPayloadBytes }) {
  return errorEnvelope('PAYLOAD_TOO_LARGE', message, { max_payload_bytes: maxPayloadBytes })
}

export function staleTimestampError({ message, serverTime, freshnessWindowSeconds }) {
  return errorEnvelope('STALE_TIMESTAMP', message, {
    server_time: serverTime,
    freshness_window_seconds: freshnessWindowSeconds,
  })
}

export function signatureInvalidError({ message }) {
  return errorEnvelope('SIGNATURE_INVALID', message)
}

export function attestationInvalidError({ message, reason }) {
  return errorEnvelope('ATTESTATION_INVALID', message, { reason })
}

export function attestationRequiredError({ message, requiredClaims, trustedIssuers }) {
  return errorEnvelope('ATTESTATION_REQUIRED', message, {
    required_claims: requiredClaims,
    trusted_issuers: trustedIssuers,
  })
}

export function powInsufficientError({ message, requiredDifficulty }) {
  return errorEnvelope('POW_INSUFFICIENT', message, { required_difficulty: requiredDifficulty })
}

export function quotaExceededError({ message, retryAfter }) {
  return errorEnvelope('QUOTA_EXCEEDED', message, { retry_after: retryAfter })
}
