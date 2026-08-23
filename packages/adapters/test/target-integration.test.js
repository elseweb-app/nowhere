// Confirms the split of responsibility described in SPEC.md §6.1 actually holds end to
// end: the adapter names the site-specific canonical URL, and packages/protocol's
// normalizeUrl performs the generic normalization on top of it, without this package
// reimplementing any part of that generic half itself.

import { describe, expect, it } from 'vitest'
import { normalizeUrl } from '@elseweb/protocol'
import { xAdapter } from '../src/x.js'

describe('xAdapter.canonicalTargetUrl feeding packages/protocol normalizeUrl', () => {
  it('collapses every main-feed variant to the same normalized page identity', () => {
    const variants = [
      'https://x.com/',
      'https://X.COM/home',
      'https://x.com/explore',
      'https://x.com/i/bookmarks',
    ]
    const normalized = variants.map((url) => normalizeUrl(xAdapter.canonicalTargetUrl(url)))
    expect(new Set(normalized).size).toBe(1)
    expect(normalized[0]).toBe('https://x.com/')
  })

  it('keeps a status url a distinct target after normalization', () => {
    const statusUrl = 'https://x.com/jack/status/20'
    expect(normalizeUrl(xAdapter.canonicalTargetUrl(statusUrl))).toBe(
      'https://x.com/jack/status/20'
    )
  })
})
