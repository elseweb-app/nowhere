// x.com adapter — tested against saved HTML fixture strings, never a live browser, per
// packages/adapters/AGENTS.md.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { xAdapter } from '../src/x.js'

const fixturesDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadFixtureDocument(filename) {
  const html = readFileSync(path.join(fixturesDirectory, filename), 'utf8')
  return new JSDOM(html).window.document
}

describe('xAdapter.matches', () => {
  it('matches x.com URLs', () => {
    expect(xAdapter.matches('https://x.com/home')).toBe(true)
    expect(xAdapter.matches('https://www.x.com/home')).toBe(true)
  })

  it('does not match a different host', () => {
    expect(xAdapter.matches('https://example.com/')).toBe(false)
  })
})

describe('xAdapter.canonicalTargetUrl — main feed collapse', () => {
  it.each([
    'https://x.com/',
    'https://x.com/home',
    'https://x.com/explore',
    'https://x.com/i/bookmarks',
    'https://x.com/i/lists/12345',
  ])('collapses %s to the site root', (url) => {
    expect(xAdapter.canonicalTargetUrl(url)).toBe('https://x.com/')
  })

  it('does not collapse a status URL', () => {
    const url = 'https://x.com/jack/status/20'
    expect(xAdapter.canonicalTargetUrl(url)).toBe(url)
  })

  it('does not collapse a profile page', () => {
    const url = 'https://x.com/jack'
    expect(xAdapter.canonicalTargetUrl(url)).toBe(url)
  })
})

describe('xAdapter.anchorIdFor', () => {
  it('extracts the status id from a permalink', () => {
    const document = loadFixtureDocument('x-tweet-permalink.html')
    const tweet = document.querySelector('[data-testid="tweet"]')
    expect(xAdapter.anchorIdFor(tweet)).toBe('20')
  })

  it('refuses to derive an id when the only thing available is DOM position', () => {
    const document = loadFixtureDocument('x-tweet-no-permalink.html')
    const tweet = document.querySelector('[data-testid="tweet"]')
    expect(xAdapter.anchorIdFor(tweet)).toBeNull()
  })
})

describe('xAdapter.findComposerAnchor', () => {
  it('finds the inline post button when its testid is present', () => {
    const document = loadFixtureDocument('x-composer.html')
    const anchor = xAdapter.findComposerAnchor(document)
    expect(anchor?.getAttribute('data-testid')).toBe('tweetButtonInline')
  })

  it('falls back to the toolbar once the button testids have been renamed', () => {
    const document = loadFixtureDocument('x-composer-fallback.html')
    const anchor = xAdapter.findComposerAnchor(document)
    expect(anchor?.getAttribute('data-testid')).toBe('toolBar')
  })
})

describe('xAdapter.findOverlayAnchor', () => {
  it('finds the primary column when its testid is present', () => {
    const document = loadFixtureDocument('x-overlay-primary.html')
    const anchor = xAdapter.findOverlayAnchor(document)
    expect(anchor?.getAttribute('data-testid')).toBe('primaryColumn')
  })

  it('falls back to the ARIA main landmark once the testid has been renamed', () => {
    const document = loadFixtureDocument('x-overlay-fallback.html')
    const anchor = xAdapter.findOverlayAnchor(document)
    expect(anchor?.tagName.toLowerCase()).toBe('main')
  })
})
