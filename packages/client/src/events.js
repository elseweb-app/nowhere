// Event construction — SPEC.md sections 4, 5 and 6. Builds envelopes ready for mining
// and signing. Never sets `nonce`, `id` or `sig` (mining and signing own those), and
// never sees a private key: `identity` is only `{ publicKey, identityMode }`.
//
// Schemas in packages/protocol are `strictObject`, so a field a kind does not require
// MUST be omitted rather than set to an empty value (SPEC.md §4) — every builder below
// is careful to spread optional fields in only when they exist.

import { deriveTarget } from '@elseweb/protocol'
import { ElsewebError } from './errors.js'

async function resolveTarget(pageUrl, canonicalizeUrl) {
  const canonicalUrl = canonicalizeUrl ? canonicalizeUrl(pageUrl) : pageUrl
  try {
    return await deriveTarget(canonicalUrl)
  } catch (cause) {
    throw new ElsewebError('INVALID_TARGET_URL', `not a valid target URL: ${pageUrl}`, { cause })
  }
}

// SPEC.md §6.3: a client SHOULD verify page_id equals the hash of page_url and treat a
// mismatch as untrustworthy. A reply denormalizes these fields from its root, so before
// building on top of a root this checks the root was not corrupted or forged.
async function assertConsistentTarget(pageId, pageUrl) {
  const recomputed = await resolveTarget(pageUrl)
  if (recomputed.page_id !== pageId) {
    throw new ElsewebError('INVALID_TARGET_URL', 'root page_id does not match hash(page_url)')
  }
}

function baseEnvelope({ kind, identity, now, attestations = [] }) {
  return {
    v: 1,
    kind,
    pubkey: identity.publicKey,
    created_at: now,
    identity_mode: identity.identityMode,
    attestations,
  }
}

export async function buildShare({
  pageUrl,
  text,
  anchorId,
  identity,
  now,
  attestations,
  canonicalizeUrl,
}) {
  const target = await resolveTarget(pageUrl, canonicalizeUrl)
  return {
    ...baseEnvelope({ kind: 'share', identity, now, attestations }),
    page_id: target.page_id,
    page_url: target.page_url,
    ...(anchorId !== undefined ? { anchor: { id: anchorId } } : {}),
    content: { text },
  }
}

// A reply's root_id is the share at the top of the thread: parent.id when the parent
// is itself a share, parent.root_id when the parent is a reply (SPEC.md §5.2). Its own
// page_id/page_url/anchor MUST match the root's, and a parent that already validated
// carries them pre-denormalized, so copying them here is correct by transitivity.
async function resolveReplyTargetFromParent(parent) {
  if (!parent || (parent.kind !== 'share' && parent.kind !== 'reply')) {
    throw new TypeError('buildReply requires parent to be a share or reply event')
  }
  await assertConsistentTarget(parent.page_id, parent.page_url)
  return {
    parentId: parent.id,
    rootId: parent.kind === 'share' ? parent.id : parent.root_id,
    pageId: parent.page_id,
    pageUrl: parent.page_url,
    anchor: parent.anchor,
  }
}

async function resolveReplyTargetFromIds({ parentId, rootId, pageUrl, anchor, canonicalizeUrl }) {
  const target = await resolveTarget(pageUrl, canonicalizeUrl)
  return { parentId, rootId, pageId: target.page_id, pageUrl: target.page_url, anchor }
}

export async function buildReply(options) {
  const { text, identity, now, attestations, parent } = options
  const target = parent
    ? await resolveReplyTargetFromParent(parent)
    : await resolveReplyTargetFromIds(options)

  return {
    ...baseEnvelope({ kind: 'reply', identity, now, attestations }),
    page_id: target.pageId,
    page_url: target.pageUrl,
    parent_id: target.parentId,
    root_id: target.rootId,
    ...(target.anchor !== undefined ? { anchor: target.anchor } : {}),
    content: { text },
  }
}

export function buildVote({ targetId, value, identity, now, attestations }) {
  if (value !== 1 && value !== -1) {
    throw new TypeError(`vote value must be 1 or -1, got ${value}`)
  }
  return {
    ...baseEnvelope({ kind: 'vote', identity, now, attestations }),
    target_id: targetId,
    content: { value },
  }
}

const ID_HEX_LENGTH = 64
const SIG_HEX_LENGTH = 128
// Mining rarely needs more than a few million tries, so nine digits is a realistic
// upper bound on nonce width — this only has to be a safe estimate checked before
// mining starts, never a byte-exact count of the final encoded event.
const NONCE_DIGIT_ESTIMATE = 9

// The size a mined and signed event will have once mining adds `nonce`/`id` and
// signing adds `sig`, none of which exist on `draft` yet. Lets a caller reject an
// oversized payload against a relay's `max_payload_bytes` before spending minutes
// mining something that would only be rejected afterward.
export function estimateEncodedBytes(draft) {
  const draftBytes = new TextEncoder().encode(JSON.stringify(draft)).length
  const addedFields =
    `"nonce":${'9'.repeat(NONCE_DIGIT_ESTIMATE)},` +
    `"id":"${'a'.repeat(ID_HEX_LENGTH)}",` +
    `"sig":"${'a'.repeat(SIG_HEX_LENGTH)}",`
  return draftBytes + new TextEncoder().encode(addedFields).length
}
