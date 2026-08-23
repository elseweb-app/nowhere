// Target identity — SPEC.md section 6.
//
// Two users looking at the same thing must derive the same `page_id`, or the network
// silently splits into groups that cannot see each other. Normalization is therefore
// exact and ordered: it follows the generic rules in SPEC.md 6.1, in order, and
// nothing here is allowed to drift from `test/vectors/target.json`, which is the
// executable form of that section.
//
// The site-specific half of normalization (collapsing x.com/home to the site root, and
// so on) lives in an adapter, not here. This module only normalizes the URL an adapter
// — or, absent one, the current page — hands it.

import { sha256, toHex } from './crypto.js'

const EXACT_TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'dclid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  'ref_url',
  '_ga',
])

function isTrackingParam(name) {
  return name.startsWith('utm_') || EXACT_TRACKING_PARAMS.has(name)
}

function parseHttpUrl(input) {
  // The URL class already rejects garbage input; it just does not know which schemes
  // this protocol accepts, so that check happens separately below.
  let parsed
  try {
    parsed = new URL(input)
  } catch {
    throw new TypeError(`not a valid URL: ${input}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`unsupported scheme: ${parsed.protocol}`)
  }
  return parsed
}

function normalizeHost(parsed) {
  // A trailing dot denotes the DNS root and is invisible to every resolver, so "x.com"
  // and "x.com." must land on the same target. The URL class lowercases the host and
  // removes a default port for us already; it does not strip the trailing dot.
  const hostname = parsed.hostname.endsWith('.') ? parsed.hostname.slice(0, -1) : parsed.hostname
  return parsed.port ? `${hostname}:${parsed.port}` : hostname
}

function isHexDigit(character) {
  return character !== undefined && /^[0-9a-fA-F]$/.test(character)
}

function isUnreservedByte(byte) {
  const isUpperAlpha = byte >= 0x41 && byte <= 0x5a
  const isLowerAlpha = byte >= 0x61 && byte <= 0x7a
  const isDigit = byte >= 0x30 && byte <= 0x39
  const isMark = byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e // - . _ ~
  return isUpperAlpha || isLowerAlpha || isDigit || isMark
}

// Decodes any percent-escape that encodes an unreserved character, and uppercases the
// hex digits of every escape that is left in place. The URL class does neither of these
// consistently on its own — it preserves whatever casing and decoding state the input
// already had — so this has to be a second, explicit pass to be idempotent.
function normalizePercentEncoding(text) {
  let normalized = ''
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character !== '%' || !isHexDigit(text[index + 1]) || !isHexDigit(text[index + 2])) {
      normalized += character
      continue
    }
    const hex = text.slice(index + 1, index + 3)
    const byte = parseInt(hex, 16)
    normalized += isUnreservedByte(byte) ? String.fromCharCode(byte) : `%${hex.toUpperCase()}`
    index += 2
  }
  return normalized
}

function splitQueryPair(pair) {
  const equalsIndex = pair.indexOf('=')
  if (equalsIndex === -1) return [pair, '']
  return [pair.slice(0, equalsIndex), pair.slice(equalsIndex + 1)]
}

function compareQueryPairs([nameA, valueA], [nameB, valueB]) {
  if (nameA !== nameB) return nameA < nameB ? -1 : 1
  if (valueA !== valueB) return valueA < valueB ? -1 : 1
  return 0
}

function normalizeQuery(search) {
  const rawQuery = search.startsWith('?') ? search.slice(1) : search
  if (rawQuery === '') return ''

  const pairs = rawQuery
    .split('&')
    .map(splitQueryPair)
    .map(([name, value]) => [normalizePercentEncoding(name), normalizePercentEncoding(value)])
    .filter(([name]) => !isTrackingParam(name))
    .sort(compareQueryPairs)

  // Stripping tracking parameters can leave nothing behind; the '?' does not survive
  // an empty query, or two URLs that differ only by a dropped utm_ tag would still
  // fail to converge on the same normalized string.
  if (pairs.length === 0) return ''
  return `?${pairs.map(([name, value]) => `${name}=${value}`).join('&')}`
}

export function normalizeUrl(url) {
  const parsed = parseHttpUrl(url)
  const host = normalizeHost(parsed)
  const path = normalizePercentEncoding(parsed.pathname)
  const query = normalizeQuery(parsed.search)
  // Fragment is intentionally never read: it is dropped, not merely left off the output.
  return `${parsed.protocol}//${host}${path}${query}`
}

export async function deriveTarget(url) {
  const pageUrl = normalizeUrl(url)
  const digest = await sha256(new TextEncoder().encode(pageUrl))
  return { page_url: pageUrl, page_id: toHex(digest) }
}

export function sameTarget(a, b) {
  if (a.page_id !== b.page_id) return false
  // An anchor narrows a target; its absence is not the same anchor as any other
  // absence-or-value, so `undefined`/`null` must compare equal only to each other.
  const anchorIdA = a.anchor?.id ?? null
  const anchorIdB = b.anchor?.id ?? null
  return anchorIdA === anchorIdB
}
