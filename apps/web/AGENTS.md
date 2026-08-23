# AGENTS.md — apps/web

The everywhere.app website. Read the root `AGENTS.md` first.

Stack: **SvelteKit**, plain JavaScript.

## Scope

In scope:

- Landing page — what everywhere.app is, how to install the extension.
- Documentation.
- **The published relay standard** — the HTTP contract from `relay/AGENTS.md` written up
  for people who want to run their own relay. This is the site's most important page;
  federation only works if the contract is public and readable.

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
- Anything the site receives from outside (form input, an API response) is validated with
  `packages/protocol` schemas before use.
- Secrets only in `$env/static/private` or `$env/dynamic/private`, never in code that can
  reach the client.

## Verification

`pnpm --filter web dev` and check the pages you touched, then `pnpm --filter web build`
to confirm the production build is clean.
