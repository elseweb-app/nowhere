import { describe, it, expect, vi } from 'vitest'
import { createRelay, actionForRejectionCode } from '../src/relay.js'
import {
  createFakeClock,
  jsonResponse,
  makePolicy,
  makeStubFetch,
  makeAuthor,
  makeShareEvent,
} from './helpers.js'

// The rejection-code -> action mapping is the client's entire understanding of
// SPEC.md section 16. If a code is missing or maps to the wrong action, a client either
// retries forever on something permanent or gives up on something recoverable.
describe('actionForRejectionCode', () => {
  const expected = {
    UNSUPPORTED_VERSION: 'abandon',
    UNSUPPORTED_KIND: 'abandon_relay',
    SCHEMA_INVALID: 'abandon',
    PAYLOAD_TOO_LARGE: 'shrink_and_remine',
    STALE_TIMESTAMP: 'fix_clock_and_remine',
    SIGNATURE_INVALID: 'abandon',
    ATTESTATION_INVALID: 'refresh_attestation',
    ATTESTATION_REQUIRED: 'surface_to_user',
    POW_INSUFFICIENT: 'remine',
    QUOTA_EXCEEDED: 'wait',
  }

  for (const [code, action] of Object.entries(expected)) {
    it(`maps ${code} to ${action}`, () => {
      expect(actionForRejectionCode(code)).toBe(action)
    })
  }

  it('falls back to abandon for an unrecognized code', () => {
    expect(actionForRejectionCode('SOMETHING_NEW')).toBe('abandon')
  })
})

describe('createRelay construction', () => {
  it('requires an injected fetch implementation', () => {
    expect(() => createRelay({ url: 'https://relay.example', clock: createFakeClock() })).toThrow()
  })

  it('requires an injected clock', () => {
    expect(() => createRelay({ url: 'https://relay.example', fetch: vi.fn() })).toThrow()
  })
})

describe('getPolicy', () => {
  it('fetches once and serves the cache within the TTL', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => jsonResponse(makePolicy()))
    const relay = createRelay({
      url: 'https://relay.example',
      fetch: fetchSpy,
      clock,
      policyTtlSeconds: 60,
    })

    await relay.getPolicy()
    await relay.getPolicy()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refetches once the cache has expired', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => jsonResponse(makePolicy()))
    const relay = createRelay({
      url: 'https://relay.example',
      fetch: fetchSpy,
      clock,
      policyTtlSeconds: 60,
    })

    await relay.getPolicy()
    clock.advance(61)
    await relay.getPolicy()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('throws rather than silently trusting an unparseable policy', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => jsonResponse({ not: 'a policy' }))
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    await expect(relay.getPolicy()).rejects.toThrow()
  })
})

describe('publish', () => {
  it('reports success without collapsing anything', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => jsonResponse({}))
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const author = await makeAuthor()
    const event = await makeShareEvent({ ...author, now: clock.now() })
    const result = await relay.publish(event)

    expect(result).toEqual({ relay: 'https://relay.example', ok: true, id: event.id })
  })

  it('parses a typed rejection with its extra fields and action', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'POW_INSUFFICIENT', message: 'too easy', required_difficulty: 22 } },
        { status: 400 }
      )
    )
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const author = await makeAuthor()
    const event = await makeShareEvent({ ...author, now: clock.now() })
    const result = await relay.publish(event)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('POW_INSUFFICIENT')
    expect(result.action).toBe('remine')
    expect(result.required_difficulty).toBe(22)
  })

  it('turns a network failure into a typed outcome rather than throwing', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline')
    })
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const author = await makeAuthor()
    const event = await makeShareEvent({ ...author, now: clock.now() })
    const result = await relay.publish(event)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('NETWORK_ERROR')
  })
})

describe('queryPage', () => {
  it('drops events that fail schema validation instead of throwing', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const validEvent = await makeShareEvent({ ...author, now: clock.now() })
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ events: [validEvent, { kind: 'share', not: 'valid' }] })
    )
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await relay.queryPage({ pageId: validEvent.page_id })

    expect(result.ok).toBe(true)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].id).toBe(validEvent.id)
  })

  it('times out independently rather than hanging forever', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(
      (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await relay.queryPage({ pageId: 'a'.repeat(64), timeoutMs: 15 })

    expect(result).toEqual({ relay: 'https://relay.example', ok: false, events: [] })
  })

  it('returns an empty, non-throwing result on an HTTP error', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => jsonResponse({}, { status: 500 }))
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await relay.queryPage({ pageId: 'a'.repeat(64) })

    expect(result).toEqual({ relay: 'https://relay.example', ok: false, events: [] })
  })
})

describe('getKeyStatus', () => {
  it('reports a body that is not JSON instead of throwing past the caller', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError('Unexpected token < in JSON at position 0')
      },
    }))
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    // A relay behind a proxy that answers an HTML error page with a 200 is the realistic
    // shape of this: the status says fine, the body is not the protocol's at all. Key
    // status is only an optimization, so this must degrade rather than take a publish down.
    const status = await relay.getKeyStatus('a'.repeat(64))

    expect(status.ok).toBe(false)
    expect(status.message).toMatch(/not JSON/)
  })

  it('parses a full key status response', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async (url) => {
      expect(url).toBe('https://relay.example/keys/abc123')
      return jsonResponse({
        required_difficulty: { share: 12, vote: 4 },
        remaining_quota: { per_key_per_day: 37 },
      })
    })
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await relay.getKeyStatus('abc123')

    expect(result.ok).toBe(true)
    expect(result.required_difficulty).toEqual({ share: 12, vote: 4 })
    expect(result.remaining_quota).toEqual({ per_key_per_day: 37 })
  })

  // Both fields are optional (SPEC.md section 11: a client MUST NOT assume a field's value
  // when the field is absent), so a partial answer and an empty one are the same rule.
  it.each([
    ['one field missing', { required_difficulty: { share: 0 } }],
    ['neither field present', {}],
  ])('tolerates a key status with %s', async (_name, body) => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => jsonResponse(body))
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await relay.getKeyStatus('abc123')

    expect(result.ok).toBe(true)
    expect(result.required_difficulty).toEqual(body.required_difficulty)
  })

  it('reports a non-ok response as a typed failure rather than throwing', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => jsonResponse({}, { status: 404 }))
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await relay.getKeyStatus('abc123')

    expect(result.ok).toBe(false)
  })

  it('reports a network failure as a typed outcome rather than throwing', async () => {
    const clock = createFakeClock()
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline')
    })
    const relay = createRelay({ url: 'https://relay.example', fetch: fetchSpy, clock })

    const result = await relay.getKeyStatus('abc123')

    expect(result.ok).toBe(false)
  })
})

describe('makeStubFetch routing', () => {
  it('routes policy, publish and query calls correctly', async () => {
    const clock = createFakeClock()
    const author = await makeAuthor()
    const event = await makeShareEvent({ ...author, now: clock.now() })
    const fetch = makeStubFetch({
      policy: makePolicy(),
      onPublish: () => jsonResponse({}),
      onQuery: () => jsonResponse({ events: [event] }),
    })
    const relay = createRelay({ url: 'https://relay.example', fetch, clock })

    expect((await relay.getPolicy()).protocol_versions).toEqual([1])
    expect((await relay.publish(event)).ok).toBe(true)
    expect((await relay.queryPage({ pageId: event.page_id })).events[0].id).toBe(event.id)
  })
})
