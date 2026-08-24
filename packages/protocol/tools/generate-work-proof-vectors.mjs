// Regenerates test/vectors/work-proof.json. Run from the repo root:
//   node packages/protocol/tools/generate-work-proof-vectors.mjs
//
// Same two rules as generate-vectors.mjs: never edit a vector to make an
// implementation pass, and if you are implementing work-proof.js, read SPEC.md §20,
// not this file. `node ... && git diff --exit-code` proves nobody hand-edited a vector.
import crypto from 'node:crypto'
import fs from 'node:fs'

const OUT = new URL('../test/vectors/work-proof.json', import.meta.url)
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

// Same seqSeed offset used in test/vectors/keys.json: requester=129.
const requester = keyFromSeed(seqSeed(129))

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

// A second, independent serializer, same technique as generate-vectors.mjs's `serialize`
// — used only to search for a nonce. `id` is the only field pow.js's canonicalBytes
// strips here (work-proof has no `sig` field at all).
const serialize = (wp) =>
  '{' +
  Object.keys(wp)
    .filter((k) => k !== 'id')
    .sort()
    .map((k) => JSON.stringify(k) + ':' + JSON.stringify(wp[k]))
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

const base = {
  v: 1,
  type: 'work-proof',
  purpose: 'compute-admission',
  subject: requester.pub,
  resource: 'job-request-1',
  created_at: 1755900000,
}

const mined = [8, 12, 16].map((bits) => {
  const found = mine(base, bits)
  return {
    required_difficulty: bits,
    work_proof: { ...base, nonce: found.nonce, id: found.id },
    canonical: found.canonical,
  }
})

fs.mkdirSync(new URL('.', OUT), { recursive: true })
fs.writeFileSync(
  OUT,
  JSON.stringify({ window_seconds: 300, now: 1755900100, mined }, null, 2) + '\n'
)
console.log(
  'work-proof mined:',
  mined.map((m) => m.required_difficulty + 'b@' + m.work_proof.nonce).join(' ')
)
