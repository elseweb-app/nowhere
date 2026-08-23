// x.com adapter — packages/adapters/AGENTS.md, SPEC.md §6 (target identity).
//
// x.com's own front end tags interactive elements with `data-testid` attributes for its
// internal testing. They are not a public contract, but in practice they survive far
// more deploys than the generated class names sitting next to them (those come out of
// an atomic CSS build and rotate on nearly every release). Every selector below prefers
// a `data-testid` or an ARIA/role attribute over a class name, and falls back to a
// looser structural match when the primary one is gone.

const MAIN_FEED_HOSTNAMES = new Set(['x.com', 'www.x.com'])

// These paths are all "the main feed": the home timeline, the explore tab, the bare
// root, and the family of "/i/..." internal timeline views (bookmarks, list feeds,
// notifications, and so on). None of them names a piece of content — per SPEC.md §6
// they are the same level-0 target, so they must collapse to one URL or two users on
// different feed tabs would derive different page_id values and never see each other.
const MAIN_FEED_PATHS = new Set(['/', '/home', '/explore'])

function isMainFeedPath(pathname) {
  if (MAIN_FEED_PATHS.has(pathname)) return true
  return pathname.startsWith('/i/')
}

// A status permalink looks like /{user}/status/{id}, optionally followed by
// /photo/1, /video/1, or a similar media-viewer segment. The username and any trailing
// segments do not affect identity — only the numeric id after "status" durably names
// the post, which is why the same pattern is reused below to extract an anchor id.
const STATUS_PATH_PATTERN = /^\/[^/]+\/status\/(\d+)/

function parseUrl(url) {
  // The caller may hand this an already-invalid or non-string value (see the "never
  // throw" rule in AGENTS.md). `new URL` is the only thing here that can throw, so it
  // is the only thing wrapped.
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function getHref(element) {
  if (element === null || element === undefined || typeof element.getAttribute !== 'function') {
    return ''
  }
  return element.getAttribute('href') ?? ''
}

function findStatusLink(element) {
  if (element === null || element === undefined) return null
  // The element handed in might already be the permalink anchor itself, or a container
  // — a tweet's article element — with one nested inside. On x.com the timestamp next
  // to a tweet is always wrapped in a link to that tweet's own permalink, so searching
  // for "the href with /status/ in it" finds the durable id without touching layout.
  if (STATUS_PATH_PATTERN.test(getHref(element))) return element
  if (typeof element.querySelector !== 'function') return null
  try {
    return element.querySelector('a[href*="/status/"]')
  } catch {
    return null
  }
}

function querySelectorChain(root, selectors) {
  if (root === null || root === undefined || typeof root.querySelector !== 'function') {
    return null
  }
  for (const selector of selectors) {
    try {
      const found = root.querySelector(selector)
      if (found !== null) return found
    } catch {
      // A selector in the list below is static and reviewed, so this should never
      // fire; it exists so a future typo degrades to "try the next one" rather than
      // taking the content script down on every page.
      continue
    }
  }
  return null
}

export const xAdapter = {
  matches(url) {
    const parsed = parseUrl(url)
    if (parsed === null) return false
    return MAIN_FEED_HOSTNAMES.has(parsed.hostname.toLowerCase())
  },

  canonicalTargetUrl(url) {
    const parsed = parseUrl(url)
    if (parsed === null) return url
    if (isMainFeedPath(parsed.pathname)) return 'https://x.com/'
    // A status URL, a profile page, a search page, and everything else on x.com is a
    // level-1 target: distinct content reachable by its own URL (SPEC.md §6). The
    // adapter's only job here is to say "this is not the main feed" — packages/protocol
    // performs the generic normalization (case, tracking params, trailing slash, ...).
    return url
  },

  anchorIdFor(element) {
    const link = findStatusLink(element)
    if (link === null) return null
    const match = STATUS_PATH_PATTERN.exec(getHref(link))
    // match is guarded by findStatusLink already testing the pattern, but querySelector
    // can also return an <a> whose href only contains "/status/" as a substring further
    // in (e.g. a quote-tweet link nested deeper) — re-checking the anchored pattern here
    // keeps the id extraction itself honest even if the search above gets loosened later.
    if (match === null) return null
    return match[1]
  },

  findComposerAnchor(root) {
    return querySelectorChain(root, [
      // The inline composer's own "Post" button. It exists only while a compose box is
      // open, which is exactly when there is something to mount a share control next to.
      '[data-testid="tweetButtonInline"]',
      // The full-page/modal composer (opened from a dedicated compose route) uses this
      // testid instead of the inline one.
      '[data-testid="tweetButton"]',
      // If both button testids have been renamed, the toolbar row that holds them
      // (image/gif/poll/emoji icons) is the next most stable landmark around the composer.
      '[data-testid="toolBar"]',
    ])
  },

  findOverlayAnchor(root) {
    return querySelectorChain(root, [
      // The single column that renders whatever the current page is showing — home
      // timeline, a status detail, a profile. It exists on every page shape x.com has.
      '[data-testid="primaryColumn"]',
      // Semantic landmark fallback if that testid is ever renamed.
      'main[role="main"]',
    ])
  },
}
