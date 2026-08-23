# AGENTS.md — packages/adapters

Per-site adapters. An adapter teaches the extension how to fit itself into one specific
website. Read the root `AGENTS.md` first.

The MVP ships two: `x.com` and a generic fallback.

## What an adapter is

An adapter is a plain object of pure functions. It answers, for the page it is looking
at:

- Does this adapter apply to the current page?
- Where is the host's composer, and what element do we anchor our control to?
- Where should the overlay of shared content be placed?
- What context describes the current page (used to derive page identity)?

That is the whole surface. Keep the interface identical across adapters — the extension
must never branch on which adapter it got.

## Hard rules

- **Pure DOM reading.** No network calls, no `storage`, no `chrome.*`, no side effects
  beyond returning elements the caller may mount to.
- **No knowledge of the extension.** An adapter does not import from `apps/extension`
  and does not know how or whether its answers get used.
- **Never throw.** If something cannot be found, return a null/empty result. A thrown
  error inside an adapter would take down the content script on that page.
- **This is the only place site-specific selectors are allowed.** If a selector string
  for a real website is anywhere else in the repo, it is misplaced.

## Selectors are fragile

Sites change their markup without warning; x.com does so often. Therefore:

- Every selector has a fallback chain — try the most specific, then progressively looser
  structural or role/ARIA-based selectors.
- Prefer stable signals (roles, ARIA labels, semantic structure) over generated class
  names.
- Comment *why* a selector is written the way it is, since the markup it targets is not
  visible from the code.
- If the whole chain fails, the adapter reports "not found" and the extension falls back
  to the generic adapter. Degrading is correct; breaking is not.

## Adding a new site

1. Create the adapter module for the site.
2. Implement the same interface as the existing adapters — no extra functions, no
   site-specific escape hatches leaking into the caller.
3. Give every selector a fallback chain.
4. Register it in the adapter registry, ordered so the generic fallback is last.
5. Add tests against saved HTML fixtures for that site, including a fixture where the
   primary selector fails and the fallback must take over.
6. If the site needs a new host permission, that is an approval gate — see root
   `AGENTS.md`, §8.

## Tests

Adapters are tested against HTML fixtures, not a live browser. Fixtures are saved
snapshots; when a site's markup changes, update the fixture and the selector chain in
the same PR.
