// Adapter registry — packages/adapters/AGENTS.md: the generic fallback must always be
// last and must always match, so a caller can never end up with no adapter at all.

import { describe, expect, it } from 'vitest'
import { adapterFor, xAdapter, genericAdapter } from '../src/index.js'

describe('adapterFor', () => {
  it('picks the x.com adapter for x.com', () => {
    expect(adapterFor('https://x.com/home')).toBe(xAdapter)
  })

  it('falls back to the generic adapter for a site with no dedicated adapter', () => {
    expect(adapterFor('https://news.example.com/article/1')).toBe(genericAdapter)
  })

  it('accepts a Location-like object as well as a bare url string', () => {
    expect(adapterFor({ href: 'https://x.com/explore' })).toBe(xAdapter)
    expect(adapterFor({ href: 'https://news.example.com/' })).toBe(genericAdapter)
  })

  it('always returns an adapter, even for unusable input', () => {
    expect(adapterFor(undefined)).toBe(genericAdapter)
    expect(adapterFor(null)).toBe(genericAdapter)
    expect(adapterFor(42)).toBe(genericAdapter)
    expect(adapterFor('not a url at all')).toBe(genericAdapter)
  })
})
