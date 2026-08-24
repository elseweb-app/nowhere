// Rejection envelopes for the compute-transport endpoints (relay/src/compute.js).
// Deliberately a separate, open set of codes from errors.js: SPEC.md §16's rejection
// codes are specific to the `/events` contract, and compute admission is
// consumer/router-side logic that introduces no relay endpoint or code under that
// section (SPEC.md §21). Same `{ error: { code, message, ...extra } }` shape, so a
// client already handling one error envelope shape does not need a second parser.

const HTTP_STATUS_BY_CODE = {
  SCHEMA_INVALID: 400,
  WORK_PROOF_INVALID: 400,
  CAPABILITY_MISMATCH: 400,
  DELEGATION_INVALID: 401,
  JOB_NOT_FOUND: 404,
  JOB_NOT_CLAIMABLE: 409,
  RECEIPT_INVALID: 400,
}

export function statusForComputeCode(code) {
  return HTTP_STATUS_BY_CODE[code] ?? 400
}

export function computeError(code, message, extra = {}) {
  return { error: { code, message, ...extra } }
}
