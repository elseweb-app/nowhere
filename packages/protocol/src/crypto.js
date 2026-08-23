// Cryptographic primitives, WebCrypto only.
//
// This package runs in an MV3 service worker, in a SvelteKit page and in a Capacitor
// WebView, so there are no `node:` imports here and there never should be. Everything
// below is reachable through `globalThis.crypto`, which is why the protocol chose
// Ed25519 and SHA-256 in the first place: a conforming client needs no crypto dependency.

const subtle = globalThis.crypto.subtle

// WebCrypto has no 'raw' import for Ed25519 private keys, only PKCS8. This is the fixed
// DER prefix for a PKCS8-wrapped Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

const HEX = '0123456789abcdef'

export function toHex(bytes) {
  let out = ''
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15]
  return out
}

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new TypeError('hex string must have an even length')
  }
  if (!/^[0-9a-f]*$/.test(hex)) {
    throw new TypeError('hex string must be lowercase 0-9a-f')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes))
}

function pkcs8FromSeed(seedHex) {
  const seed = fromHex(seedHex)
  if (seed.length !== 32) throw new TypeError('Ed25519 seed must be 32 bytes')
  const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32)
  out.set(PKCS8_ED25519_PREFIX, 0)
  out.set(seed, PKCS8_ED25519_PREFIX.length)
  return out
}

const importPrivate = (seedHex) =>
  subtle.importKey('pkcs8', pkcs8FromSeed(seedHex), { name: 'Ed25519' }, false, ['sign'])

const importPublic = (pubkeyHex) =>
  subtle.importKey('raw', fromHex(pubkeyHex), { name: 'Ed25519' }, true, ['verify'])

export async function publicKeyFromPrivate(seedHex) {
  // WebCrypto will not hand back the public half of an imported private key, so the
  // seed is re-imported as an extractable JWK pair to read it out.
  const key = await subtle.importKey('pkcs8', pkcs8FromSeed(seedHex), { name: 'Ed25519' }, true, [
    'sign',
  ])
  const jwk = await subtle.exportKey('jwk', key)
  return toHex(base64UrlToBytes(jwk.x))
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export async function sign(seedHex, bytes) {
  const key = await importPrivate(seedHex)
  return toHex(new Uint8Array(await subtle.sign({ name: 'Ed25519' }, key, bytes)))
}

export async function verify(pubkeyHex, bytes, sigHex) {
  let key
  try {
    key = await importPublic(pubkeyHex)
  } catch {
    return false
  }
  let signature
  try {
    signature = fromHex(sigHex)
  } catch {
    return false
  }
  return subtle.verify({ name: 'Ed25519' }, key, signature, bytes)
}

export async function generateKeyPair() {
  // Extractable on purpose. A user must be able to carry one identity across the
  // extension, the site and mobile; a key that cannot leave the runtime that created it
  // strands its owner, and that cannot be corrected for keys already issued.
  const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const jwk = await subtle.exportKey('jwk', pair.privateKey)
  return {
    privateKey: toHex(base64UrlToBytes(jwk.d)),
    publicKey: toHex(base64UrlToBytes(jwk.x)),
  }
}

export function randomBytes(length) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}
