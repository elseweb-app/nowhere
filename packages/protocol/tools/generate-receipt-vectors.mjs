// Regenerates test/vectors/receipt.json. Run from the repo root:
//   node packages/protocol/tools/generate-receipt-vectors.mjs
//
// Same two rules as generate-vectors.mjs: never edit a vector to make an
// implementation pass, and if you are implementing receipt.js, read SPEC.md §19,
// not this file. `node ... && git diff --exit-code` proves nobody hand-edited a vector.
import crypto from 'node:crypto'
import fs from 'node:fs'

const OUT = new URL('../test/vectors/receipt.json', import.meta.url)
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

// Same seqSeed offsets used in test/vectors/keys.json: worker=97, requester=129.
const worker = keyFromSeed(seqSeed(97))
const requester = keyFromSeed(seqSeed(129))

function receipt({ jobId, resultHash, started_at, finished_at }) {
  return {
    v: 1,
    type: 'compute-receipt',
    job_id: jobId,
    requester_pubkey: requester.pub,
    worker_pubkey: worker.pub,
    capability: 'text.generate',
    usage: { unit: 'tokens', amount: 512 },
    result_hash: resultHash,
    started_at,
    finished_at,
  }
}

// Excludes worker_sig and requester_sig — what the worker signs.
function canonicalWorker(body) {
  return (
    `{"capability":"${body.capability}","finished_at":${body.finished_at},` +
    `"job_id":"${body.job_id}","requester_pubkey":"${body.requester_pubkey}",` +
    `"result_hash":"${body.result_hash}","started_at":${body.started_at},` +
    `"type":"${body.type}","usage":{"amount":${body.usage.amount},"unit":"${body.usage.unit}"},` +
    `"v":${body.v},"worker_pubkey":"${body.worker_pubkey}"}`
  )
}

// Excludes only requester_sig — what the requester countersigns, binding it to the
// exact worker-signed receipt (worker_sig included).
function canonicalCountersign(body, workerSig) {
  return (
    `{"capability":"${body.capability}","finished_at":${body.finished_at},` +
    `"job_id":"${body.job_id}","requester_pubkey":"${body.requester_pubkey}",` +
    `"result_hash":"${body.result_hash}","started_at":${body.started_at},` +
    `"type":"${body.type}","usage":{"amount":${body.usage.amount},"unit":"${body.usage.unit}"},` +
    `"v":${body.v},"worker_pubkey":"${body.worker_pubkey}","worker_sig":"${workerSig}"}`
  )
}

const base = { started_at: 1755900000, finished_at: 1755900030 }

const cases = [
  {
    name: 'valid — worker signs, no countersignature yet',
    body: receipt({ jobId: 'aa'.repeat(16), resultHash: 'ab'.repeat(32), ...base }),
    workerSigner: worker.priv,
    requesterSigner: null,
    expect: 'valid',
    countersigned: false,
  },
  {
    name: 'valid and countersigned — requester confirms receipt',
    body: receipt({ jobId: 'bb'.repeat(16), resultHash: 'cd'.repeat(32), ...base }),
    workerSigner: worker.priv,
    requesterSigner: requester.priv,
    expect: 'valid',
    countersigned: true,
  },
  {
    name: 'worker signature does not verify',
    body: receipt({ jobId: 'cc'.repeat(16), resultHash: 'ef'.repeat(32), ...base }),
    workerSigner: requester.priv,
    requesterSigner: null,
    expect: 'worker_signature_invalid',
    countersigned: false,
  },
  {
    name: 'requester countersignature does not verify',
    body: receipt({ jobId: 'dd'.repeat(16), resultHash: '12'.repeat(32), ...base }),
    workerSigner: worker.priv,
    requesterSigner: worker.priv,
    expect: 'requester_signature_invalid',
    countersigned: false,
  },
  {
    name: 'finished before it started',
    body: receipt({
      jobId: 'ee'.repeat(16),
      resultHash: '34'.repeat(32),
      started_at: 1755900030,
      finished_at: 1755900000,
    }),
    workerSigner: worker.priv,
    requesterSigner: null,
    expect: 'invalid_timespan',
    countersigned: false,
  },
]

const vectors = cases.map((c) => {
  const workerCanonical = canonicalWorker(c.body)
  const workerDigest = sha256(workerCanonical)
  const worker_sig = sign(c.workerSigner, workerDigest)
  let requester_sig
  let countersignCanonical
  if (c.requesterSigner) {
    countersignCanonical = canonicalCountersign(c.body, worker_sig)
    requester_sig = sign(c.requesterSigner, sha256(countersignCanonical))
  }
  return {
    name: c.name,
    receipt: { ...c.body, worker_sig, ...(requester_sig ? { requester_sig } : {}) },
    canonical_worker: workerCanonical,
    canonical_countersign: countersignCanonical ?? null,
    expect: c.expect,
    countersigned: c.countersigned,
  }
})

fs.mkdirSync(new URL('.', OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ cases: vectors }, null, 2) + '\n')
console.log('receipt cases:', vectors.length)
