# AGENTS.md — apps/extension

The MV3 browser extension. Read the root `AGENTS.md` first; this file only covers what
is specific to the extension.

Stack: **WXT** + **plain Svelte**. SvelteKit is not used here — no router, no SSR, no
`$app` imports. Svelte components are mounted directly.

## Entrypoints

WXT discovers entrypoints from the `entrypoints/` directory. Expected shape:

```
entrypoints/
  content.js          # injected into host pages
  background.js       # MV3 service worker
  popup/              # toolbar popup (Svelte)
  options/            # settings, including the relay URL (Svelte)
```

To add an entrypoint, add the file/directory under `entrypoints/` — do not hand-edit a
generated manifest. Matches and permissions are declared in the entrypoint definition or
`wxt.config.js`.

## Content script rules

- **Mount into a shadow root.** Use WXT's shadow-root content-script UI helper. Nothing
  the extension renders may inherit or leak host styles.
- **Do not write into the host page.** Reading the DOM is fine. The only permitted
  mutation is attaching our own container to the anchor point an adapter reports.
- **Never touch the host site's own share/post flow.** Not its handlers, not its state,
  not its network calls.
- **x.com is a SPA.** The composer is destroyed and rebuilt on navigation and on modal
  open/close. A one-shot `querySelector` at script start is wrong. Use a
  `MutationObserver` and re-attach whenever the anchor disappears. Attaching twice is a
  bug — mark our container and check for it before mounting.
- **Selectors live in `packages/adapters`, never here.** This directory contains no
  site-specific strings. If you are writing `[data-testid=...]` in this package, it
  belongs in an adapter instead.
- If the adapter cannot find an anchor, fall back to the generic adapter and keep
  running. Do not throw out of the content script.

## Background service worker

MV3 workers are killed at any time. Therefore:

- No module-level mutable state. Anything that must survive goes to `storage`.
- No `setInterval` for scheduling; use alarms.
- Treat every wake-up as a cold start.

## Messaging

Content script <-> background messages are validated with schemas from
`packages/protocol` on both send and receive. An unrecognized or invalid message is
rejected and logged, never acted on.

## Configuration

The relay URL is user-configurable and read from `storage`. It is never a literal in
this package. If no relay is configured, the extension surfaces that state — it does not
fall back to a built-in default silently.

## Bundle budget

The content script runs on every page the user visits. Keep it small; treat growth as a
regression. Popup and options bundles are less constrained but still not a dumping
ground. Adding a dependency to this package requires approval (root `AGENTS.md`, §7).

## Manual verification

There is no automated E2E for the extension in the MVP. After a change, load the dev
build in Chrome and confirm:

1. On x.com, the share control appears next to the composer.
2. Navigate within x.com (home -> profile -> back) — the control is still there, exactly
   once.
3. Open the composer in modal form — the control appears there too.
4. Share a piece of content, and confirm in the Network tab that **no request carrying
   that content goes to x.com** — only to the configured relay.
5. Content shared by another user appears on the same page.
6. On a site with no adapter, the extension loads and the generic fallback behaves.
