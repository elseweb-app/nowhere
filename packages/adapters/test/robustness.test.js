// packages/adapters/AGENTS.md: "Never throw. If something cannot be found, return a
// null/empty result. A thrown error inside an adapter would take down the content
// script on that page." This file exercises every adapter against garbage and empty
// input across all five interface functions to hold that guarantee.

import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { xAdapter } from '../src/x.js'
import { genericAdapter } from '../src/generic.js'

const adapters = [
  ['xAdapter', xAdapter],
  ['genericAdapter', genericAdapter],
]

describe.each(adapters)('%s never throws', (_name, adapter) => {
  it('on garbage or missing urls', () => {
    expect(() => adapter.matches('not a url')).not.toThrow()
    expect(() => adapter.matches(undefined)).not.toThrow()
    expect(() => adapter.matches(null)).not.toThrow()
    expect(() => adapter.canonicalTargetUrl('not a url')).not.toThrow()
    expect(() => adapter.canonicalTargetUrl(undefined)).not.toThrow()
  })

  it('on missing, empty, or shape-less elements', () => {
    expect(() => adapter.anchorIdFor(null)).not.toThrow()
    expect(() => adapter.anchorIdFor(undefined)).not.toThrow()
    expect(() => adapter.anchorIdFor({})).not.toThrow()
    expect(() => adapter.anchorIdFor('a string, not an element')).not.toThrow()
  })

  it('when handed a genuinely empty document', () => {
    const emptyDocument = new JSDOM('').window.document
    expect(() => adapter.findComposerAnchor(emptyDocument)).not.toThrow()
    expect(() => adapter.findOverlayAnchor(emptyDocument)).not.toThrow()
    expect(adapter.findComposerAnchor(emptyDocument)).toBeNull()
  })

  it('on completely unusable root values', () => {
    expect(() => adapter.findComposerAnchor(null)).not.toThrow()
    expect(() => adapter.findComposerAnchor(undefined)).not.toThrow()
    expect(() => adapter.findComposerAnchor({})).not.toThrow()
    expect(() => adapter.findOverlayAnchor(null)).not.toThrow()
    expect(() => adapter.findOverlayAnchor(undefined)).not.toThrow()
    expect(() => adapter.findOverlayAnchor({})).not.toThrow()
  })
})
