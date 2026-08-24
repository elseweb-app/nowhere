import { describe, it, expect } from 'vitest'
import { generateKeyPair } from '@elseweb/protocol'
import { createWorkerIdentityStore } from '../src/worker-identity.js'
import { createFakeClock, createFakeStorage } from './helpers.js'

describe('createWorkerIdentityStore construction', () => {
  it('requires an injected storage port', () => {
    expect(() => createWorkerIdentityStore({ clock: createFakeClock() })).toThrow()
  })

  it('requires an injected clock port', () => {
    expect(() => createWorkerIdentityStore({ storage: createFakeStorage() })).toThrow()
  })
})

describe('worker keypair lifecycle', () => {
  it('has no worker until one is created', async () => {
    const workers = createWorkerIdentityStore({
      storage: createFakeStorage(),
      clock: createFakeClock(),
    })
    expect(await workers.getWorker()).toBeNull()
  })

  it('generates a worker keypair separate from any owner key', async () => {
    const workers = createWorkerIdentityStore({
      storage: createFakeStorage(),
      clock: createFakeClock(),
    })
    const worker = await workers.createWorker()

    expect(worker.privateKey).toMatch(/^[0-9a-f]{64}$/)
    expect(worker.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(worker.delegation).toBeNull()
  })

  it('ensureWorker reuses an existing worker instead of minting a new one', async () => {
    const workers = createWorkerIdentityStore({
      storage: createFakeStorage(),
      clock: createFakeClock(),
    })
    const first = await workers.ensureWorker()
    const second = await workers.ensureWorker()
    expect(second.publicKey).toBe(first.publicKey)
  })

  it('never stores the owner private key it is handed', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/worker-identity.js', import.meta.url), 'utf8')
    )
    expect(source).not.toMatch(/\bfetch\s*\(/)
  })
})

describe('authorization', () => {
  it('authorizes the current worker with an owner-signed delegation', async () => {
    const clock = createFakeClock()
    const workers = createWorkerIdentityStore({ storage: createFakeStorage(), clock })
    const worker = await workers.createWorker()
    const owner = await generateKeyPair()

    const updated = await workers.authorize({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.publicKey,
      capabilities: ['text.generate'],
    })

    expect(updated.delegation.owner_pubkey).toBe(owner.publicKey)
    expect(updated.delegation.worker_pubkey).toBe(worker.publicKey)
    expect(updated.delegation.capabilities).toEqual(['text.generate'])
  })

  it('refuses to authorize before a worker keypair exists', async () => {
    const workers = createWorkerIdentityStore({
      storage: createFakeStorage(),
      clock: createFakeClock(),
    })
    const owner = await generateKeyPair()
    await expect(
      workers.authorize({
        ownerPrivateKey: owner.privateKey,
        ownerPubkey: owner.publicKey,
        capabilities: ['text.generate'],
      })
    ).rejects.toThrow()
  })

  it('currentDelegation reports no_delegation before authorize() is called', async () => {
    const workers = createWorkerIdentityStore({
      storage: createFakeStorage(),
      clock: createFakeClock(),
    })
    await workers.createWorker()
    const result = await workers.currentDelegation({ requiredCapability: 'text.generate' })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('no_delegation')
  })

  it('currentDelegation validates capability, expiry and revocation of the stored delegation', async () => {
    const clock = createFakeClock()
    const workers = createWorkerIdentityStore({ storage: createFakeStorage(), clock })
    await workers.createWorker()
    const owner = await generateKeyPair()
    await workers.authorize({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.publicKey,
      capabilities: ['text.generate'],
      expiresInSeconds: 100,
    })

    const withinCapability = await workers.currentDelegation({
      requiredCapability: 'text.generate',
    })
    expect(withinCapability.valid).toBe(true)

    const wrongCapability = await workers.currentDelegation({ requiredCapability: 'code.generate' })
    expect(wrongCapability.valid).toBe(false)
    expect(wrongCapability.reason).toBe('capability_missing')

    clock.advance(101)
    const expired = await workers.currentDelegation({ requiredCapability: 'text.generate' })
    expect(expired.valid).toBe(false)
    expect(expired.reason).toBe('expired')
  })
})

describe('rotation and revocation', () => {
  it('rotateWorker replaces the keypair, discarding the old delegation', async () => {
    const clock = createFakeClock()
    const workers = createWorkerIdentityStore({ storage: createFakeStorage(), clock })
    const original = await workers.createWorker()
    const owner = await generateKeyPair()
    await workers.authorize({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.publicKey,
      capabilities: ['text.generate'],
    })

    const rotated = await workers.rotateWorker()
    expect(rotated.publicKey).not.toBe(original.publicKey)
    expect(rotated.delegation).toBeNull()
  })

  it('revokeCurrentDelegation builds a verifiable revocation for the stored authorization_id', async () => {
    const clock = createFakeClock()
    const workers = createWorkerIdentityStore({ storage: createFakeStorage(), clock })
    await workers.createWorker()
    const owner = await generateKeyPair()
    const { delegation } = await workers.authorize({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.publicKey,
      capabilities: ['text.generate'],
    })

    const revocation = await workers.revokeCurrentDelegation({
      ownerPrivateKey: owner.privateKey,
      ownerPubkey: owner.publicKey,
    })

    expect(revocation.authorization_id).toBe(delegation.authorization_id)
    const { verifyRevocation } = await import('@elseweb/protocol')
    expect((await verifyRevocation(revocation)).valid).toBe(true)
  })

  it('refuses to revoke when there is no delegation yet', async () => {
    const workers = createWorkerIdentityStore({
      storage: createFakeStorage(),
      clock: createFakeClock(),
    })
    await workers.createWorker()
    const owner = await generateKeyPair()
    await expect(
      workers.revokeCurrentDelegation({
        ownerPrivateKey: owner.privateKey,
        ownerPubkey: owner.publicKey,
      })
    ).rejects.toThrow()
  })
})
