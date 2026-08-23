// Where the relay stops being trusted. Two checks, both of which only a client can make:
//
//   - `page_id` must equal hash(`page_url`). SPEC.md section 6.3 forbids a relay from
//     re-deriving page identity — that would couple every relay to one normalization
//     version — so a forged pairing between a hash and a URL is caught here or nowhere.
//   - `sig` must verify against `pubkey`. The relay checked this too, but a hostile relay
//     is precisely the case the signature exists for, and trusting its word would make
//     the signature decorative.

import { deriveTarget, verifyEvent } from '@elseweb/protocol'

export async function isAuthentic(event) {
  if (event.page_url !== undefined) {
    const target = await deriveTarget(event.page_url).catch(() => null)
    if (!target || target.page_id !== event.page_id) return false
  }
  return verifyEvent(event)
}

// Drops what does not survive rather than reporting it. A caller can do nothing useful
// with an event whose signature is wrong except not show it, and passing it along would
// put that decision in every consumer instead of here once.
export async function keepAuthentic(carried) {
  const verdicts = await Promise.all(carried.map(({ event }) => isAuthentic(event)))
  return carried.filter((_, index) => verdicts[index])
}
