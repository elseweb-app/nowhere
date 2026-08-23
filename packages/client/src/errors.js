// One error type for everything a consumer can hit, so an application needs a single
// catch rather than one per layer. `code` is the stable discriminator and `action` says
// what to do about it — the two things SPEC.md section 16 insists a client must be able
// to tell apart, because a client that cannot will either retry forever or give up on a
// recoverable error.
//
// Relay-sent codes come from the spec. Local codes describe failures that never reach a
// relay, and they live alongside the wire codes deliberately: to the application calling
// publishShare(), "this relay is over quota" and "you have no writable relay configured"
// are the same kind of event, and splitting them across two error types would only push
// the union back onto the caller.

import { actionForRejectionCode } from './relay.js'

// Failures that happen before or instead of a relay round trip. The spec does not name
// these because they never travel; they still need stable codes for the same reason the
// wire codes do.
const LOCAL_ACTIONS = {
  NO_WRITABLE_RELAY: 'configure_relays',
  NO_IDENTITY: 'create_identity',
  INVALID_TARGET_URL: 'abandon',
  MINING_ABORTED: 'abandon',
  MINING_EXHAUSTED: 'retry_later',
  PAYLOAD_TOO_LARGE: 'shrink_and_remine',
  RELAY_UNREACHABLE: 'retry_later',
}

export function actionForCode(code) {
  return LOCAL_ACTIONS[code] ?? actionForRejectionCode(code)
}

export class ElsewebError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ElsewebError'
    this.code = code
    this.action = actionForCode(code)
    // The per-code extra fields from SPEC.md section 16 — required_difficulty, retry_after,
    // required_claims and friends — are spread onto the error rather than nested, so a
    // caller reads error.required_difficulty without first knowing which shape to unwrap.
    Object.assign(this, details)
  }
}

// Builds an ElsewebError from the typed outcome createRelay() returns, preserving the
// extra fields the relay sent. Used where a per-relay outcome has to be raised rather
// than reported — a single-relay publish that failed everywhere, for instance.
export function errorFromOutcome(outcome) {
  const extra = { ...outcome }
  // `ok` and `action` are re-derived by the constructor; carrying the relay's copies
  // through would let a stale action shadow the one actionForCode() computes.
  delete extra.ok
  delete extra.action
  delete extra.code
  delete extra.message
  return new ElsewebError(
    outcome.code,
    outcome.message ?? `relay ${outcome.relay} rejected the event`,
    extra
  )
}

export function isElsewebError(value) {
  return value instanceof ElsewebError
}
