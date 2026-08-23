import { describe, it, expect } from 'vitest'
import {
  safeParseEvent,
  safeParsePolicy,
  safeParseErrorEnvelope,
  safeParseAttestation,
} from '../src/schemas.js'
import { canonicalVectors, attestationVectors } from './helpers/vectors.js'

const signedVector = (predicate) => {
  const vector = canonicalVectors.find(predicate)
  return { ...vector.event, id: vector.id, sig: vector.sig }
}

const share = () => signedVector((v) => v.event.kind === 'share' && !v.event.anchor)
const anchoredShare = () => signedVector((v) => v.event.kind === 'share' && v.event.anchor)
const reply = () => signedVector((v) => v.event.kind === 'reply')
const vote = () => signedVector((v) => v.event.kind === 'vote')

describe('event schema — accepts the vectors', () => {
  it('accepts a share', () => expect(safeParseEvent(share()).success).toBe(true))
  it('accepts an anchored share', () => expect(safeParseEvent(anchoredShare()).success).toBe(true))
  it('accepts a reply', () => expect(safeParseEvent(reply()).success).toBe(true))
  it('accepts a vote', () => expect(safeParseEvent(vote()).success).toBe(true))
})

describe('event schema — envelope', () => {
  const reject = (mutate) => {
    const event = share()
    return safeParseEvent(mutate(event) ?? event).success
  }

  it('rejects an unknown kind', () => {
    expect(reject((e) => ({ ...e, kind: 'boost' }))).toBe(false)
  })

  it('rejects a missing version', () => {
    expect(
      reject((e) => {
        const { v, ...rest } = e
        void v
        return rest
      })
    ).toBe(false)
  })

  it('rejects a non-integer created_at', () => {
    expect(reject((e) => ({ ...e, created_at: 1.5 }))).toBe(false)
  })

  it('rejects a malformed pubkey', () => {
    expect(reject((e) => ({ ...e, pubkey: 'nothex' }))).toBe(false)
    expect(reject((e) => ({ ...e, pubkey: 'ab' }))).toBe(false)
  })

  it('rejects an unknown identity_mode', () => {
    expect(reject((e) => ({ ...e, identity_mode: 'anonymous' }))).toBe(false)
  })

  it('rejects a null field rather than treating it as absent', () => {
    // An absent field and a null field are different canonical forms, so null is
    // never an acceptable stand-in for "not set".
    expect(reject((e) => ({ ...e, anchor: null }))).toBe(false)
  })

  it('requires attestations to be present, even when empty', () => {
    expect(
      reject((e) => {
        const { attestations, ...rest } = e
        void attestations
        return rest
      })
    ).toBe(false)
  })
})

describe('event schema — fields belong to their kind', () => {
  it('rejects a share carrying reply fields', () => {
    expect(safeParseEvent({ ...share(), parent_id: 'aa'.repeat(32) }).success).toBe(false)
  })

  it('rejects a share carrying a vote target', () => {
    expect(safeParseEvent({ ...share(), target_id: 'aa'.repeat(32) }).success).toBe(false)
  })

  it('rejects a share with no page_url', () => {
    const { page_url, ...rest } = share()
    void page_url
    expect(safeParseEvent(rest).success).toBe(false)
  })

  it('rejects a reply with no root_id', () => {
    const { root_id, ...rest } = reply()
    void root_id
    expect(safeParseEvent(rest).success).toBe(false)
  })

  it('rejects a vote carrying a page', () => {
    expect(safeParseEvent({ ...vote(), page_id: 'aa'.repeat(32) }).success).toBe(false)
  })

  it('rejects a vote value other than 1 or -1', () => {
    expect(safeParseEvent({ ...vote(), content: { value: 0 } }).success).toBe(false)
    expect(safeParseEvent({ ...vote(), content: { value: 2 } }).success).toBe(false)
  })

  it('rejects media, which is reserved in v1', () => {
    const event = share()
    expect(safeParseEvent({ ...event, content: { ...event.content, media: [] } }).success).toBe(
      false
    )
  })
})

describe('policy document schema', () => {
  const policy = {
    protocol_versions: [1],
    kinds: ['share', 'reply', 'vote'],
    pow: {
      default_difficulty: { share: 20, reply: 18, vote: 14 },
      max_difficulty: 24,
      challenge_required: false,
    },
    freshness_window_seconds: 300,
    max_payload_bytes: 8192,
    attestations: { required_for: [], trusted_issuers: [], feed_requires: ['membership'] },
    quotas: { per_key_per_day: 50 },
  }

  it('accepts the documented example', () => {
    expect(safeParsePolicy(policy).success).toBe(true)
  })

  it('tolerates fields it does not know about', () => {
    // A relay may advertise more than we understand; that must not break the client.
    expect(safeParsePolicy({ ...policy, experimental_thing: true }).success).toBe(true)
  })

  it('rejects a missing protocol_versions', () => {
    const { protocol_versions, ...rest } = policy
    void protocol_versions
    expect(safeParsePolicy(rest).success).toBe(false)
  })
})

describe('error envelope schema', () => {
  it('accepts a rejection with its extra fields', () => {
    const result = safeParseErrorEnvelope({
      error: { code: 'POW_INSUFFICIENT', message: 'not enough work', required_difficulty: 22 },
    })
    expect(result.success).toBe(true)
  })

  it('accepts every documented code', () => {
    const codes = [
      'UNSUPPORTED_VERSION',
      'UNSUPPORTED_KIND',
      'SCHEMA_INVALID',
      'PAYLOAD_TOO_LARGE',
      'STALE_TIMESTAMP',
      'SIGNATURE_INVALID',
      'ATTESTATION_INVALID',
      'ATTESTATION_REQUIRED',
      'POW_INSUFFICIENT',
      'QUOTA_EXCEEDED',
    ]
    for (const code of codes) {
      expect(safeParseErrorEnvelope({ error: { code, message: 'x' } }).success).toBe(true)
    }
  })

  it('rejects an unknown code', () => {
    expect(safeParseErrorEnvelope({ error: { code: 'TEAPOT', message: 'x' } }).success).toBe(false)
  })
})

describe('attestation schema', () => {
  const valid = () => attestationVectors.cases[0].attestation

  it('accepts the issuer-signed vectors', () => {
    for (const testCase of attestationVectors.cases) {
      expect(safeParseAttestation(testCase.attestation).success).toBe(true)
    }
  })

  it('rejects a malformed issuer-signed attestation', () => {
    // It must not fall through to the permissive unknown-type branch just because the
    // strict branch failed — that would let a broken claim parse as an opaque one.
    expect(safeParseAttestation({ ...valid(), issuer: 'nothex' }).success).toBe(false)
    expect(safeParseAttestation({ ...valid(), expires_at: 1.5 }).success).toBe(false)
    const { sig, ...unsigned } = valid()
    void sig
    expect(safeParseAttestation(unsigned).success).toBe(false)
  })

  it('rejects an unknown field on an issuer-signed attestation', () => {
    expect(safeParseAttestation({ ...valid(), extra: true }).success).toBe(false)
  })

  it('accepts an attestation type it has never heard of', () => {
    // Adding a type later must not be a breaking change, so parsing tolerates what
    // verification will go on to ignore.
    expect(
      safeParseAttestation({ type: 'host-account', value: '@x', proof_url: 'u' }).success
    ).toBe(true)
  })

  it('rejects an attestation with no type at all', () => {
    expect(safeParseAttestation({ claim: 'membership' }).success).toBe(false)
  })

  it('rejects an event carrying a malformed attestation', () => {
    const event = { ...share(), attestations: [{ type: 'issuer-signed', issuer: 'nope' }] }
    expect(safeParseEvent(event).success).toBe(false)
  })

  it('accepts an event carrying a valid attestation', () => {
    const event = { ...share(), attestations: [valid()] }
    expect(safeParseEvent(event).success).toBe(true)
  })
})
