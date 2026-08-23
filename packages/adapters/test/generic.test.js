// Generic fallback adapter — packages/adapters/AGENTS.md, SPEC.md §6.1.

import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { genericAdapter } from '../src/generic.js'

describe('genericAdapter.matches', () => {
  it('matches any site with no dedicated adapter', () => {
    expect(genericAdapter.matches('https://a-blog-nobody-wrote-an-adapter-for.example/')).toBe(true)
  })

  it('matches even unusable input, since it must always be the last resort', () => {
    expect(genericAdapter.matches('')).toBe(true)
    expect(genericAdapter.matches(undefined)).toBe(true)
  })
})

describe('genericAdapter.canonicalTargetUrl', () => {
  it('returns the url unchanged for packages/protocol to normalize generically', () => {
    const url = 'https://blog.example/posts/1?utm_source=newsletter'
    expect(genericAdapter.canonicalTargetUrl(url)).toBe(url)
  })
})

describe('genericAdapter.anchorIdFor', () => {
  it('never derives an anchor id, having no site knowledge to derive one from', () => {
    expect(genericAdapter.anchorIdFor()).toBeNull()
    expect(
      genericAdapter.anchorIdFor(new JSDOM('<div id="x"></div>').window.document.body)
    ).toBeNull()
  })
})

describe('genericAdapter.findComposerAnchor', () => {
  it('never offers a composer anchor on an unrecognized site', () => {
    const document = new JSDOM('<body><textarea></textarea></body>').window.document
    expect(genericAdapter.findComposerAnchor(document)).toBeNull()
  })
})

describe('genericAdapter.findOverlayAnchor', () => {
  it('mounts on the document body, the one thing every HTML page has', () => {
    const document = new JSDOM('<body><p>hello</p></body>').window.document
    const anchor = genericAdapter.findOverlayAnchor(document)
    expect(anchor?.tagName.toLowerCase()).toBe('body')
  })
})
