// Regenerates test/vectors/challenge.json. Run from the repo root:
//   node packages/protocol/tools/generate-challenge-vectors.mjs
//
// Same two rules as generate-vectors.mjs: never edit a vector to make an
// implementation pass, and if you are implementing challenge.js, read SPEC.md §17,
// not this file. `node ... && git diff --exit-code` proves nobody hand-edited a vector.
import crypto from 'node:crypto'
import fs from 'node:fs'

const OUT = new URL('../test/vectors/challenge.json', import.meta.url)
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
const sign = (key, digest) => hex(crypto.sign(null, digest, key))

// Same seqSeed offsets as generate-vectors.mjs (author=1, issuer=33): this file adds
// no new identities, `subject` here is the same `author` key.
const subject = keyFromSeed(seqSeed(1))
const other = keyFromSeed(seqSeed(33)) // reused as the "wrong signer" for one case

function challenge({ audience, resource, issued_at, expires_at, nonce }) {
  return {
    v: 1,
    type: 'proof-of-control',
    action: 'link-account',
    audience,
    subject: subject.pub,
    resource,
    nonce,
    issued_at,
    expires_at,
  }
}

const cases = [
  {
    name: 'valid — subject signs its own proof of control',
    now: 1755900100,
    audience: 'example-consumer',
    body: challenge({
      audience: 'example-consumer',
      resource: 'account-42',
      issued_at: 1755900000,
      expires_at: 1755900300,
      nonce: 'aa'.repeat(16),
    }),
    signer: subject.priv,
    expect: 'valid',
  },
  {
    name: 'expired — signature is fine, the clock is not',
    now: 1755900300,
    audience: 'example-consumer',
    body: challenge({
      audience: 'example-consumer',
      resource: 'account-42',
      issued_at: 1755900000,
      expires_at: 1755900300,
      nonce: 'bb'.repeat(16),
    }),
    signer: subject.priv,
    expect: 'expired',
  },
  {
    name: 'signed by someone other than the claimed subject',
    now: 1755900100,
    audience: 'example-consumer',
    body: challenge({
      audience: 'example-consumer',
      resource: 'account-42',
      issued_at: 1755900000,
      expires_at: 1755900300,
      nonce: 'cc'.repeat(16),
    }),
    signer: other.priv,
    expect: 'signature_invalid',
  },
]

// Hand-written JCS: keys of every case body sort alphabetically as
// action, audience, expires_at, issued_at, nonce, resource, subject, type, v — which
// is already ASCII order, so no reordering is needed beyond writing them in that
// sequence.
function canonicalOf(body) {
  return (
    `{"action":"${body.action}","audience":"${body.audience}",` +
    `"expires_at":${body.expires_at},"issued_at":${body.issued_at},` +
    `"nonce":"${body.nonce}","resource":"${body.resource}","subject":"${body.subject}",` +
    `"type":"${body.type}","v":${body.v}}`
  )
}

const vectors = cases.map((c) => {
  const canonical = canonicalOf(c.body)
  const digest = sha256(canonical)
  return {
    name: c.name,
    now: c.now,
    audience: c.audience,
    challenge: { ...c.body, sig: sign(c.signer, digest) },
    canonical,
    expect: c.expect,
  }
})

fs.mkdirSync(new URL('.', OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ cases: vectors }, null, 2) + '\n')
console.log('challenge cases:', vectors.length)
