import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vectors')

export const loadVectors = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))

export const canonicalVectors = loadVectors('canonical.json')
export const powVectors = loadVectors('pow.json')
export const targetVectors = loadVectors('target.json')
export const attestationVectors = loadVectors('attestations.json')
export const keyVectors = loadVectors('keys.json')
export const challengeVectors = loadVectors('challenge.json')
export const delegationVectors = loadVectors('delegation.json')
export const receiptVectors = loadVectors('receipt.json')
export const workProofVectors = loadVectors('work-proof.json')
