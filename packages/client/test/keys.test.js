import { describe, it, expect } from 'vitest'
import { createKeyStore } from '../src/keys.js'
import { createFakeClock, createFakeStorage } from './helpers.js'

describe('createKeyStore construction', () => {
  it('requires an injected storage port', () => {
    expect(() => createKeyStore({ clock: createFakeClock() })).toThrow()
  })

  it('requires an injected clock port', () => {
    expect(() => createKeyStore({ storage: createFakeStorage() })).toThrow()
  })
})

describe('identity lifecycle', () => {
  it('has no identity until one is created', async () => {
    const keys = createKeyStore({ storage: createFakeStorage(), clock: createFakeClock() })
    expect(await keys.getIdentity()).toBeNull()
  })

  it('generates an extractable keypair that round trips through storage', async () => {
    const keys = createKeyStore({ storage: createFakeStorage(), clock: createFakeClock() })
    const created = await keys.createIdentity()

    expect(created.privateKey).toMatch(/^[0-9a-f]{64}$/)
    expect(created.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(created.identityMode).toBe('persistent')

    const loaded = await keys.getIdentity()
    expect(loaded).toEqual(created)
  })

  it('ensureIdentity reuses an existing identity instead of minting a new one', async () => {
    const keys = createKeyStore({ storage: createFakeStorage(), clock: createFakeClock() })
    const first = await keys.ensureIdentity()
    const second = await keys.ensureIdentity()
    expect(second).toEqual(first)
  })

  it('supports an ephemeral identity mode', async () => {
    const keys = createKeyStore({ storage: createFakeStorage(), clock: createFakeClock() })
    const identity = await keys.createIdentity({ identityMode: 'ephemeral' })
    expect(identity.identityMode).toBe('ephemeral')
  })

  it('clearIdentity removes the stored identity', async () => {
    const keys = createKeyStore({ storage: createFakeStorage(), clock: createFakeClock() })
    await keys.createIdentity()
    await keys.clearIdentity()
    expect(await keys.getIdentity()).toBeNull()
  })

  it('never stores the private key anywhere fetch could reach', async () => {
    // Not a network test in itself, but a guard against this module ever growing a
    // fetch call: the private key must never leave the device (root AGENTS.md
    // non-negotiable 5), and this is the one file that could quietly break that.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/keys.js', import.meta.url), 'utf8')
    )
    expect(source).not.toMatch(/\bfetch\s*\(/)
  })
})

describe('key transfer between devices', () => {
  it('round trips an identity from one device store to another', async () => {
    const clock = createFakeClock()
    const source = createKeyStore({ storage: createFakeStorage(), clock })
    const original = await source.createIdentity()

    const { envelope, code } = await source.exportForTransfer()

    const destination = createKeyStore({ storage: createFakeStorage(), clock })
    const imported = await destination.importFromTransfer({ envelope, code })

    expect(imported.privateKey).toBe(original.privateKey)
    expect(imported.publicKey).toBe(original.publicKey)
  })

  it('fails cleanly on a wrong transfer code', async () => {
    const clock = createFakeClock()
    const source = createKeyStore({ storage: createFakeStorage(), clock })
    await source.createIdentity()
    const { envelope } = await source.exportForTransfer()

    const destination = createKeyStore({ storage: createFakeStorage(), clock })
    await expect(
      destination.importFromTransfer({ envelope, code: 'ffffffffffffffff' })
    ).rejects.toThrow()
    expect(await destination.getIdentity()).toBeNull()
  })

  it('refuses to transfer when there is no identity yet', async () => {
    const keys = createKeyStore({ storage: createFakeStorage(), clock: createFakeClock() })
    await expect(keys.exportForTransfer()).rejects.toThrow()
  })

  it('rejects an expired transfer envelope', async () => {
    const clock = createFakeClock()
    const source = createKeyStore({ storage: createFakeStorage(), clock })
    await source.createIdentity()
    const { envelope, code } = await source.exportForTransfer({ expiresInSeconds: 10 })

    clock.advance(11)
    const destination = createKeyStore({ storage: createFakeStorage(), clock })
    await expect(destination.importFromTransfer({ envelope, code })).rejects.toThrow()
  })
})
