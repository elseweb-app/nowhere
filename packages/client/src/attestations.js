// Attestation trust for a client (SPEC.md section 8). Trust is explicitly NOT a protocol
// question — every client and relay keeps its own trusted-issuer list — so this module
// is the one place that list is applied. protocol's verifyAttestation() does the
// stateless cryptographic and expiry checks; this wraps it without collapsing its five
// distinguishable outcomes into a single yes/no, because a client that cannot tell
// "wrong issuer" from "expired" cannot tell a user what to do next.

import { verifyAttestation } from '@elseweb/protocol'

// An absent or empty trusted-issuer list trusts nobody (SPEC.md section 8.1) — that is
// the safe default and MUST NOT be read as trusting everybody. Defaulting to `[]` here,
// rather than letting `undefined` flow through, keeps that reading a deliberate choice
// at this boundary instead of an accident further down.
export async function verifyEventAttestations(event, { trustedIssuers = [], now } = {}) {
  const attestations = event.attestations ?? []
  const outcomes = []
  for (const attestation of attestations) {
    // SPEC.md section 8.2: a type this verifier does not recognize is ignored, not
    // rejected — protocol's verifyAttestation() already reports that as its own
    // distinguishable `unsupported_type` reason, which this treats like any other
    // untrusted outcome below rather than special-casing it into an error.
    const result = await verifyAttestation(attestation, {
      now,
      trustedIssuers,
      subject: event.pubkey,
    })
    outcomes.push({ attestation, ...result })
  }
  return outcomes
}

// The subset a caller actually acts on: attestations that verified as trusted,
// unexpired, and bound to this event's own author. Everything else — wrong signature,
// untrusted issuer, expired, unrecognized type, subject mismatch — is folded together
// here on purpose, because past this point a caller only ever wants "does this count".
export function trustedAttestations(outcomes) {
  return outcomes.filter((outcome) => outcome.valid).map((outcome) => outcome.attestation)
}
