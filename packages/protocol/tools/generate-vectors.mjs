// Regenerates the test vectors. Run from the repo root:
//   node packages/protocol/tools/generate-vectors.mjs
//   node packages/protocol/tools/generate-target-vectors.mjs
//
// The expected values in here — canonical strings, normalized URLs — are HAND-WRITTEN
// from SPEC.md. Only the arithmetic is computed. That is the point: this file is a second,
// independent reading of the spec, written with Node's own crypto rather than the
// WebCrypto the package uses, so agreement between the two means something.
//
// Two rules keep it worth having:
//   1. Never change a vector to make an implementation pass. Change the implementation, or
//      change the spec and this file together and say so.
//   2. If you are implementing a module, do not read this file. Read SPEC.md. The whole
//      value of the vectors is that they were written by someone who was not looking at
//      your code, and it evaporates the moment the reading is shared.
//
// `node packages/protocol/tools/generate-vectors.mjs && git diff --exit-code` proves
// nobody hand-edited a vector.
import crypto from 'node:crypto'
import fs from 'node:fs'

const OUT = new URL('../test/vectors/', import.meta.url)
fs.mkdirSync(OUT, { recursive: true })

const hex = (b) => Buffer.from(b).toString('hex')
const sha256 = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest()

const PK8 = Buffer.from('302e020100300506032b657004220420', 'hex')
function keyFromSeed(seedHex) {
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([PK8, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  })
  const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' })
  return { priv, pub: hex(spki.subarray(spki.length - 32)), seed: seedHex }
}
const seqSeed = (start) =>
  Array.from({ length: 32 }, (_, i) => (start + i).toString(16).padStart(2, '0')).join('')

const author = keyFromSeed(seqSeed(1))
const issuer = keyFromSeed(seqSeed(33))
const sign = (key, digest) => hex(crypto.sign(null, digest, key))

const leadingZeroBits = (buf) => {
  let n = 0
  for (const byte of buf) {
    if (byte === 0) {
      n += 8
      continue
    }
    n += Math.clz32(byte) - 24
    break
  }
  return n
}

const ROOT_ID = hex(sha256('https://x.com/'))
const STATUS_ID = hex(sha256('https://x.com/u/status/123'))

// Control characters built from codepoints so no literal control byte is in this source.
const CTRL = String.fromCharCode(1)
const TAB = String.fromCharCode(9)
const LF = String.fromCharCode(10)

const canonicalCases = [
  {
    name: 'share, minimal, level 0 target',
    event: {
      v: 1,
      kind: 'share',
      pubkey: author.pub,
      created_at: 1755900000,
      identity_mode: 'persistent',
      nonce: 0,
      attestations: [],
      page_id: ROOT_ID,
      page_url: 'https://x.com/',
      content: { text: 'merhaba' },
    },
    canonical:
      '{"attestations":[],"content":{"text":"merhaba"},"created_at":1755900000,' +
      '"identity_mode":"persistent","kind":"share","nonce":0,' +
      '"page_id":"' +
      ROOT_ID +
      '","page_url":"https://x.com/","pubkey":"' +
      author.pub +
      '","v":1}',
  },
  {
    name: 'share with anchor — an absent field and a present one are different events',
    event: {
      v: 1,
      kind: 'share',
      pubkey: author.pub,
      created_at: 1755900000,
      identity_mode: 'persistent',
      nonce: 0,
      attestations: [],
      page_id: STATUS_ID,
      page_url: 'https://x.com/u/status/123',
      anchor: { id: '456' },
      content: { text: 'merhaba' },
    },
    canonical:
      '{"anchor":{"id":"456"},"attestations":[],"content":{"text":"merhaba"},' +
      '"created_at":1755900000,"identity_mode":"persistent","kind":"share","nonce":0,' +
      '"page_id":"' +
      STATUS_ID +
      '","page_url":"https://x.com/u/status/123","pubkey":"' +
      author.pub +
      '","v":1}',
  },
  {
    name: 'unicode is emitted raw as UTF-8, never escaped',
    event: {
      v: 1,
      kind: 'share',
      pubkey: author.pub,
      created_at: 1755900000,
      identity_mode: 'persistent',
      nonce: 0,
      attestations: [],
      page_id: ROOT_ID,
      page_url: 'https://x.com/',
      content: { text: 'İstanbul çğüşiö 🌍' },
    },
    canonical:
      '{"attestations":[],"content":{"text":"İstanbul çğüşiö 🌍"},"created_at":1755900000,' +
      '"identity_mode":"persistent","kind":"share","nonce":0,' +
      '"page_id":"' +
      ROOT_ID +
      '","page_url":"https://x.com/","pubkey":"' +
      author.pub +
      '","v":1}',
  },
  {
    name: 'string escaping: quote, backslash, newline, tab, other control char',
    event: {
      v: 1,
      kind: 'share',
      pubkey: author.pub,
      created_at: 1755900000,
      identity_mode: 'persistent',
      nonce: 0,
      attestations: [],
      page_id: ROOT_ID,
      page_url: 'https://x.com/',
      content: { text: 'a"b\\c' + LF + 'd' + TAB + 'e' + CTRL + 'f' },
    },
    canonical:
      '{"attestations":[],"content":{"text":"a\\"b\\\\c\\nd\\te\\u0001f"},' +
      '"created_at":1755900000,"identity_mode":"persistent","kind":"share","nonce":0,' +
      '"page_id":"' +
      ROOT_ID +
      '","page_url":"https://x.com/","pubkey":"' +
      author.pub +
      '","v":1}',
  },
  {
    name: 'vote — smallest envelope, negative integer value',
    event: {
      v: 1,
      kind: 'vote',
      pubkey: author.pub,
      created_at: 1755900123,
      identity_mode: 'persistent',
      nonce: 7,
      attestations: [],
      target_id: 'aa'.repeat(32),
      content: { value: -1 },
    },
    canonical:
      '{"attestations":[],"content":{"value":-1},"created_at":1755900123,' +
      '"identity_mode":"persistent","kind":"vote","nonce":7,"pubkey":"' +
      author.pub +
      '","target_id":"' +
      'aa'.repeat(32) +
      '","v":1}',
  },
  {
    name: 'reply — carries the thread and the denormalized target',
    event: {
      v: 1,
      kind: 'reply',
      pubkey: author.pub,
      created_at: 1755900200,
      identity_mode: 'ephemeral',
      nonce: 3,
      attestations: [],
      page_id: STATUS_ID,
      page_url: 'https://x.com/u/status/123',
      parent_id: 'bb'.repeat(32),
      root_id: 'cc'.repeat(32),
      content: { text: 'cevap' },
    },
    canonical:
      '{"attestations":[],"content":{"text":"cevap"},"created_at":1755900200,' +
      '"identity_mode":"ephemeral","kind":"reply","nonce":3,' +
      '"page_id":"' +
      STATUS_ID +
      '","page_url":"https://x.com/u/status/123","parent_id":"' +
      'bb'.repeat(32) +
      '","pubkey":"' +
      author.pub +
      '","root_id":"' +
      'cc'.repeat(32) +
      '","v":1}',
  },
]

const canonical = canonicalCases.map((c) => {
  const digest = sha256(c.canonical)
  return {
    name: c.name,
    event: c.event,
    canonical: c.canonical,
    id: hex(digest),
    sig: sign(author.priv, digest),
  }
})

// A second, independent serializer used ONLY to search for nonces.
const serialize = (ev) =>
  '{' +
  Object.keys(ev)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + JSON.stringify(ev[k]))
    .join(',') +
  '}'

function mine(base, bits) {
  for (let nonce = 0; nonce < 5e7; nonce++) {
    const canon = serialize({ ...base, nonce })
    const d = sha256(canon)
    if (leadingZeroBits(d) >= bits) {
      return { nonce, canonical: canon, id: hex(d), actual_difficulty: leadingZeroBits(d) }
    }
  }
  throw new Error('no nonce found for ' + bits)
}

const powBase = {
  v: 1,
  kind: 'share',
  pubkey: author.pub,
  created_at: 1755900000,
  identity_mode: 'persistent',
  attestations: [],
  page_id: ROOT_ID,
  page_url: 'https://x.com/',
  content: { text: 'pow' },
}
const pow = {
  mined: [8, 12, 16].map((bits) => ({
    required_difficulty: bits,
    event: { ...powBase, nonce: mine(powBase, bits).nonce },
    ...mine(powBase, bits),
  })),
  leading_zero_bits: [
    { digest: '00'.repeat(32), bits: 256 },
    { digest: '80' + '00'.repeat(31), bits: 0 },
    { digest: '40' + '00'.repeat(31), bits: 1 },
    { digest: '01' + '00'.repeat(31), bits: 7 },
    { digest: '00ff' + '00'.repeat(30), bits: 8 },
    { digest: '0001' + '00'.repeat(30), bits: 15 },
    { digest: 'ff' + '00'.repeat(31), bits: 0 },
  ],
}

function attestation({ claim, issued_at, expires_at, signer }) {
  const body = {
    type: 'issuer-signed',
    issuer: issuer.pub,
    claim,
    subject: author.pub,
    issued_at,
    expires_at,
  }
  const canon = serialize(body)
  // `canonical` is a helper for implementers, kept OUTSIDE the attestation so that no
  // production code ever has to know a test fixture field exists.
  return { value: { ...body, sig: sign(signer, sha256(canon)) }, canonical: canon }
}

const spread = ({ value, canonical }) => ({ attestation: value, canonical })

const attestations = {
  trusted_issuers: [issuer.pub],
  cases: [
    {
      name: 'valid membership from a trusted issuer',
      now: 1755900000,
      ...spread(
        attestation({
          claim: 'membership',
          issued_at: 1755000000,
          expires_at: 1758000000,
          signer: issuer.priv,
        })
      ),
      expect: 'valid',
    },
    {
      name: 'expired — signature is fine, the clock is not',
      now: 1755900000,
      ...spread(
        attestation({
          claim: 'membership',
          issued_at: 1750000000,
          expires_at: 1755000000,
          signer: issuer.priv,
        })
      ),
      expect: 'expired',
    },
    {
      name: 'signed by someone other than the named issuer',
      now: 1755900000,
      ...spread(
        attestation({
          claim: 'membership',
          issued_at: 1755000000,
          expires_at: 1758000000,
          signer: author.priv,
        })
      ),
      expect: 'signature_invalid',
    },
    {
      name: 'cryptographically valid but the issuer is not trusted here',
      now: 1755900000,
      trusted_issuers: [],
      ...spread(
        attestation({
          claim: 'membership',
          issued_at: 1755000000,
          expires_at: 1758000000,
          signer: issuer.priv,
        })
      ),
      expect: 'untrusted_issuer',
    },
  ],
}

const keys = {
  note: 'Deterministic test keys. Raw 32-byte Ed25519 seeds. Never use these anywhere real.',
  author: { seed: author.seed, pubkey: author.pub },
  issuer: { seed: issuer.seed, pubkey: issuer.pub },
}

const write = (f, o) => fs.writeFileSync(new URL(f, OUT), JSON.stringify(o, null, 2) + '\n')
write('canonical.json', canonical)
write('pow.json', pow)
write('keys.json', keys)
write('attestations.json', attestations)

console.log('canonical cases:', canonical.length)
console.log('pow mined:', pow.mined.map((p) => p.required_difficulty + 'b@' + p.nonce).join(' '))
console.log('author', author.pub.slice(0, 16), 'issuer', issuer.pub.slice(0, 16))
