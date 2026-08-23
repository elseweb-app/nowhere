# AGENTS.md — apps/web

The ElseWeb website. Read the root `AGENTS.md` first.

Stack: **SvelteKit**, plain JavaScript.

**This app must stay statically buildable.** A later phase wraps it with Capacitor to
become the mobile app — the same codebase, not a rewrite. Anything that only works with
a Node server at runtime breaks that, so keep server-only work off the critical path and
assume `adapter-static` is the target.

## Scope

In scope:

- Landing page — what ElseWeb is, how to install the extension.
- Documentation.
- **The feed** — the cross-page stream, and the threads, replies and votes on it. It
  reads through `packages/client` like every other surface; no relay logic is written
  here.
- **The published relay standard** — written up for people who want to run their own
  relay. This is the site's most important page; federation only works if the contract
  is public and readable. Its source of truth is `packages/protocol/SPEC.md`: the page
  is derived from the spec, never the other way round, and both change in the same PR.
  A published standard that has drifted from the spec is worse than none, because
  someone will implement a relay against it.

Out of scope:

- Extension UI. The popup and options pages live in `apps/extension` and are not
  duplicated here.
- Any code that is also needed by the extension. Shared code goes in `packages/*` and is
  imported from both. Never copy a file between `apps/web` and `apps/extension`.

## JavaScript only

- `svelte.config.js`, `vite.config.js` — no `.ts` variants, no `tsconfig.json`.
- Svelte components use `<script>`, never `<script lang="ts">`.
- Route files are `+page.js`, `+page.server.js`, `+layout.js`.

## Conventions

- Route-specific components live next to their route; anything reused across routes goes
  in `src/lib/`.
- Load data in `+page.js` / `+page.server.js`, not inside components.
- Anything the site receives from outside (form input, a relay response) is validated
  with `packages/protocol` schemas before use.
- The site supplies `packages/client` with its storage port. Web storage APIs are used
  here and nowhere else, so that Capacitor can swap the port without touching shared
  logic.
- The feed is attestation-gated, which is a **filter**, not a privilege: the trusted
  issuer list is configuration read at runtime. Never hardcode an issuer key.
- Secrets only in `$env/static/private` or `$env/dynamic/private`, never in code that can
  reach the client.

## Verification

`pnpm --filter web dev` and check the pages you touched, then `pnpm --filter web build`
to confirm the production build is clean.
