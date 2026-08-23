import { describe, it, expect } from 'vitest'
import { normalizeUrl, deriveTarget, sameTarget } from '../src/target.js'
import { targetVectors } from './helpers/vectors.js'

// Two users looking at the same thing must derive the same target, or they cannot see
// each other. These vectors are the executable form of SPEC.md section 6.

describe('normalizeUrl', () => {
  for (const vector of targetVectors.normalize) {
    it(vector.name, () => {
      expect(normalizeUrl(vector.input)).toBe(vector.normalized)
    })
  }

  it('is idempotent', () => {
    for (const vector of targetVectors.normalize) {
      expect(normalizeUrl(vector.normalized)).toBe(vector.normalized)
    }
  })

  for (const vector of targetVectors.rejected) {
    it(`rejects: ${vector.name}`, () => {
      expect(() => normalizeUrl(vector.input)).toThrow()
    })
  }
})

describe('deriveTarget', () => {
  for (const vector of targetVectors.normalize) {
    it(vector.name, async () => {
      const target = await deriveTarget(vector.input)
      expect(target.page_url).toBe(vector.normalized)
      expect(target.page_id).toBe(vector.page_id)
    })
  }

  for (const vector of targetVectors.distinct) {
    it(`different targets: ${vector.name}`, async () => {
      const a = await deriveTarget(vector.a)
      const b = await deriveTarget(vector.b)
      expect(a.page_id).toBe(vector.page_id_a)
      expect(b.page_id).toBe(vector.page_id_b)
      expect(a.page_id).not.toBe(b.page_id)
    })
  }

  for (const level of targetVectors.levels) {
    it(`level ${level.level}: ${level.note}`, async () => {
      const target = await deriveTarget(level.adapter_canonical_url)
      expect(target.page_id).toBe(level.page_id)
    })
  }

  it('does not fold the anchor into page_id', async () => {
    // The anchor narrows the target; it does not change which page the target is on.
    const withAnchor = targetVectors.levels.find((l) => l.level === 2)
    const withoutAnchor = targetVectors.levels.find((l) => l.level === 1)
    expect(withAnchor.page_id).toBe(withoutAnchor.page_id)
  })
})

describe('sameTarget', () => {
  const page = 'aa'.repeat(32)
  const other = 'bb'.repeat(32)

  it('matches identical page ids with no anchor', () => {
    expect(sameTarget({ page_id: page }, { page_id: page })).toBe(true)
  })

  it('separates different pages', () => {
    expect(sameTarget({ page_id: page }, { page_id: other })).toBe(false)
  })

  it('separates an anchored target from an unanchored one on the same page', () => {
    expect(sameTarget({ page_id: page }, { page_id: page, anchor: { id: '1' } })).toBe(false)
  })

  it('matches identical anchors', () => {
    expect(
      sameTarget({ page_id: page, anchor: { id: '1' } }, { page_id: page, anchor: { id: '1' } })
    ).toBe(true)
  })

  it('separates different anchors on the same page', () => {
    expect(
      sameTarget({ page_id: page, anchor: { id: '1' } }, { page_id: page, anchor: { id: '2' } })
    ).toBe(false)
  })
})
