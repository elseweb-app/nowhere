// Generic fallback adapter — packages/adapters/AGENTS.md, SPEC.md §6.1.
//
// Every site with no dedicated adapter runs against this one. It carries no knowledge of
// any particular site's markup, so it can only offer what holds true everywhere: the
// current URL, left for packages/protocol to normalize generically, and a mount point
// that every HTML document has. It never derives an anchor id, because a durable id can
// only come from a site's own scheme (SPEC.md §6.2), and this adapter knows none.

function resolveDocumentBody(root) {
  if (root === null || root === undefined) return null
  // `root` is ordinarily a Document, so its own .body is the answer. A test fixture may
  // instead hand in an element standing in for one; both paths are accepted so the
  // overlay still has somewhere to mount on an unrecognized site.
  if (typeof root.querySelector === 'function') {
    try {
      const body = root.querySelector('body')
      if (body !== null) return body
    } catch {
      // Fall through to the tagName check below.
    }
  }
  if (typeof root.tagName === 'string' && root.tagName.toLowerCase() === 'body') return root
  return null
}

export const genericAdapter = {
  matches() {
    // Unconditional on purpose: this is the adapter every site-specific adapter is
    // chosen over, and the one thing the registry guarantees is that some adapter
    // always matches. If this ever returned false, adapterFor would have nothing left
    // to hand back.
    return true
  },

  canonicalTargetUrl(url) {
    // No site knowledge to add here. packages/protocol's normalizeUrl performs the
    // generic half of SPEC.md §6.1 on whatever this returns, so the identity a
    // generic-adapter user gets still agrees with anyone else on the same exact URL —
    // just not on which URLs are "the same page" the way an adapter-equipped site does.
    return url
  },

  anchorIdFor() {
    // Without site knowledge there is no durable identifier to read, and SPEC.md §6.2
    // forbids inventing one from DOM position. A generic-adapter share is always a
    // level-0/level-1 target, never level-2 sub-content.
    return null
  },

  findComposerAnchor() {
    // An unknown site has no known composer to sit next to. Returning null is a real
    // answer, not a failure: per packages/adapters/AGENTS.md the extension degrades on
    // unrecognized sites by omitting inline sharing, rather than guessing at a mount
    // point that might land inside unrelated host UI.
    return null
  },

  findOverlayAnchor(root) {
    return resolveDocumentBody(root)
  },
}
