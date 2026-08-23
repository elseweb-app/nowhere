// Canonical serialization: RFC 8785 (JCS), restricted per SPEC.md §3.
//
// Signatures and proof-of-work are both computed over these exact bytes. Two
// implementations that serialize the same event differently produce signatures that
// will not verify against each other, and the cause is very hard to find from the
// outside — so every rule here is deliberately narrower than what JCS allows in
// general, closing off anything that could make two honest implementations disagree.

const SHORT_ESCAPES = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

// Only quote/backslash/control characters are escaped. Everything else — including
// every non-ASCII character — is emitted as raw UTF-8, per SPEC.md §3.
function encodeString(value) {
  let encoded = '"'
  for (const character of value) {
    if (SHORT_ESCAPES[character]) {
      encoded += SHORT_ESCAPES[character]
      continue
    }
    const codePoint = character.codePointAt(0)
    if (codePoint < 0x20) {
      encoded += '\\u' + codePoint.toString(16).padStart(4, '0')
      continue
    }
    encoded += character
  }
  return encoded + '"'
}

// Object keys sorted by UTF-16 code unit. Array.prototype.sort with no comparator
// does exactly this for strings, which is why it is used unmodified below.
function sortedKeys(value) {
  return Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
}

function serializeObject(value) {
  const entries = sortedKeys(value).map(
    (key) => `${encodeString(key)}:${serializeValue(value[key])}`
  )
  return `{${entries.join(',')}}`
}

// An absent field and a field present with `null` are different events (SPEC.md §3).
// Since the canonical form has no way to write "absent", accepting `null` here would
// silently coerce those two distinct events into the same bytes. Throwing forces the
// caller to omit the key instead.
function serializeValue(value) {
  if (value === null) {
    throw new TypeError('canonical form forbids null; omit the field instead')
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError('canonical form allows only integers, never floating point')
    }
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (typeof value === 'string') return encodeString(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(',')}]`
  if (typeof value === 'object') return serializeObject(value)
  throw new TypeError(`cannot canonicalize a value of type ${typeof value}`)
}

// Exposed separately from `canonicalize` so attestation.js (which excludes different
// fields — `sig` and the vector-only `canonical` helper, not `id`/`sig`) can reuse the
// same JCS serializer without duplicating it.
export function canonicalizeValue(value) {
  return serializeValue(value)
}

export function canonicalize(event) {
  // `id` and `sig` are the two fields the canonical form excludes entirely (SPEC.md
  // §3) — they are what the canonical bytes are hashed and signed into, so they can't
  // also be inputs to that computation.
  const { id, sig, ...rest } = event
  void id
  void sig
  return canonicalizeValue(rest)
}

export function canonicalBytes(event) {
  return new TextEncoder().encode(canonicalize(event))
}
