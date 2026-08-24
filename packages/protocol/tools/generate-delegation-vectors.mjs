// Regenerates test/vectors/delegation.json. Run from the repo root:
//   node packages/protocol/tools/generate-delegation-vectors.mjs
//
// Same two rules as generate-vectors.mjs: never edit a vector to make an
// implementation pass, and if you are implementing delegation.js, read SPEC.md §18,
// not this file. `node ... && git diff --exit-code` proves nobody hand-edited a vector.
import crypto from 'node:crypto'
import fs from 'node:fs'

const OUT = new URL('../test/vectors/delegation.json', import.meta.url)
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

// Same seqSeed offsets used in test/vectors/keys.json: owner=65, worker=97.
const owner = keyFromSeed(seqSeed(65))
const worker = keyFromSeed(seqSeed(97))

function canonicalOf(body) {
  const caps = '[' + body.capabilities.map((c) => `"${c}"`).join(',') + ']'
  return (
    `{"authorization_id":"${body.authorization_id}","capabilities":${caps},` +
    `"expires_at":${body.expires_at},"issued_at":${body.issued_at},` +
    `"owner_pubkey":"${body.owner_pubkey}","type":"${body.type}","v":${body.v},` +
    `"worker_pubkey":"${body.worker_pubkey}"}`
  )
}

function delegation({ ownerPub, workerPub, authorizationId, capabilities, issued_at, expires_at }) {
  return {
    v: 1,
    type: 'worker-delegation',
    authorization_id: authorizationId,
    owner_pubkey: ownerPub,
    worker_pubkey: workerPub,
    capabilities,
    issued_at,
    expires_at,
  }
}

const delegationCases = [
  {
    name: 'valid — owner authorizes a distinct worker key',
    now: 1755900100,
    body: delegation({
      ownerPub: owner.pub,
      workerPub: worker.pub,
      authorizationId: 'aa'.repeat(16),
      capabilities: ['text.generate'],
      issued_at: 1755900000,
      expires_at: 1755990000,
    }),
    signer: owner.priv,
    revokedIds: [],
    expect: 'valid',
  },
  {
    name: 'expired — signature is fine, the clock is not',
    now: 1755990000,
    body: delegation({
      ownerPub: owner.pub,
      workerPub: worker.pub,
      authorizationId: 'bb'.repeat(16),
      capabilities: ['text.generate'],
      issued_at: 1755900000,
      expires_at: 1755990000,
    }),
    signer: owner.priv,
    revokedIds: [],
    expect: 'expired',
  },
  {
    name: 'signed by someone other than the claimed owner',
    now: 1755900100,
    body: delegation({
      ownerPub: owner.pub,
      workerPub: worker.pub,
      authorizationId: 'cc'.repeat(16),
      capabilities: ['text.generate'],
      issued_at: 1755900000,
      expires_at: 1755990000,
    }),
    signer: worker.priv,
    revokedIds: [],
    expect: 'signature_invalid',
  },
  {
    name: 'a key cannot delegate to itself, even with a valid signature',
    now: 1755900100,
    body: delegation({
      ownerPub: owner.pub,
      workerPub: owner.pub,
      authorizationId: 'dd'.repeat(16),
      capabilities: ['text.generate'],
      issued_at: 1755900000,
      expires_at: 1755990000,
    }),
    signer: owner.priv,
    revokedIds: [],
    expect: 'self_delegation',
  },
]

const delegationVectors = delegationCases.map((c) => {
  const canonical = canonicalOf(c.body)
  const digest = sha256(canonical)
  return {
    name: c.name,
    now: c.now,
    revoked_ids: c.revokedIds,
    delegation: { ...c.body, sig: sign(c.signer, digest) },
    canonical,
    expect: c.expect,
  }
})

function canonicalRevocationOf(body) {
  return (
    `{"authorization_id":"${body.authorization_id}","owner_pubkey":"${body.owner_pubkey}",` +
    `"revoked_at":${body.revoked_at},"type":"${body.type}","v":${body.v}}`
  )
}

const revocationCases = [
  {
    name: 'valid — owner signs its own revocation',
    body: {
      v: 1,
      type: 'worker-revocation',
      authorization_id: 'aa'.repeat(16),
      owner_pubkey: owner.pub,
      revoked_at: 1755900500,
    },
    signer: owner.priv,
    expect: 'valid',
  },
  {
    name: 'signed by someone other than the claimed owner',
    body: {
      v: 1,
      type: 'worker-revocation',
      authorization_id: 'bb'.repeat(16),
      owner_pubkey: owner.pub,
      revoked_at: 1755900500,
    },
    signer: worker.priv,
    expect: 'signature_invalid',
  },
]

const revocationVectors = revocationCases.map((c) => {
  const canonical = canonicalRevocationOf(c.body)
  const digest = sha256(canonical)
  return {
    name: c.name,
    revocation: { ...c.body, sig: sign(c.signer, digest) },
    canonical,
    expect: c.expect,
  }
})

fs.mkdirSync(new URL('.', OUT), { recursive: true })
fs.writeFileSync(
  OUT,
  JSON.stringify({ cases: delegationVectors, revocations: revocationVectors }, null, 2) + '\n'
)
console.log(
  'delegation cases:',
  delegationVectors.length,
  'revocation cases:',
  revocationVectors.length
)
