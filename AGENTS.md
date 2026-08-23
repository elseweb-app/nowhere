# AGENTS.md — nowhere

Instructions for any coding agent working in this repository. This file is
tool-agnostic on purpose: no vendor-specific syntax, no file-reference macros, no XML
tags. It should read the same to every model and every editor.

Nested `AGENTS.md` files exist under `apps/*`, `packages/*` and `relay/`. The nearest
one to the file you are editing wins; it adds to this file rather than replacing it.

---

## 1. What this is

**ElseWeb** is a web2 layer that adapts itself to any website. It ships as a
Manifest V3 Chrome extension. The MVP target is x.com.

When a user has the extension installed, they see a "share with ElseWeb" control
next to x.com's own composer. The extension adapts its own UI into whatever page is
open. Content shared through that control **never reaches x.com** — it is written to
our own service. Every other user running the extension sees that content while they
are on the same page.

The network is designed to be federated. For the MVP the relay is a Supabase edge
function, but its HTTP contract is written to be a **standard** anyone can implement
and self-host. Supabase is the reference implementation, not the architecture.

Flow: `shared content -> relay -> other extension users on the same page`.

## 2. Non-negotiables

These define the product. If a change would break one of them, stop and ask before
writing code.

1. **Shared content never goes to the host site.** Not to x.com, not to any other host.
   The host site's own posting/sharing flow is never invoked, prefilled, or triggered.
2. **The host page's DOM is not polluted.** Everything injected lives inside a shadow
   root. No global CSS, no writing into the host's class/id namespace, no mutation of
   host elements beyond an anchor point needed to mount.
3. **Clients speak to a set of relays, never one.** The relay set is user-editable at
   any time, and single-relay operation is the degenerate case of a set of one — never a
   separate code path. No relay URL, key, or SDK call outside `relay/` and the configured
   transport.
4. **No participant is privileged by the protocol.** ElseWeb's own relay is a relay
   like any other. Our product decisions — an attestation-gated feed, a paid membership —
   are expressed with mechanisms available to everyone, so a community client can make
   different choices against the same network.
5. **Identity is the keypair, and it belongs to the user.** Keys are generated
   extractable so a user can carry one identity across the extension, the site and mobile.
   A private key is never sent to a server, encrypted or not.
6. **Site adapters describe behavior, not data.** A site with no adapter falls back to
   the generic adapter. The extension degrades on unknown sites; it never dies on them.

## 3. Repo map

| Path | Contains | Does not contain |
|---|---|---|
| `apps/extension` | MV3 extension: WXT entrypoints, content script, background worker, popup/options, plain Svelte UI | SvelteKit, site selectors, protocol schemas, relay logic |
| `apps/web` | ElseWeb site: SvelteKit — landing, docs, feed, the published relay standard | Extension UI, relay logic |
| `packages/protocol` | `SPEC.md` and its implementation: event schemas, canonical serialization, crypto, proof-of-work, page identity | Browser APIs, network calls, storage |
| `packages/client` | Relay pool, publishing, reading and merging, key management, ranking — everything a client does that is not UI | DOM, platform storage APIs, site selectors |
| `packages/adapters` | Per-site adapters (x.com + generic fallback) | Network calls, storage, extension internals |
| `relay/` | Reference relay: edge function, migrations, RLS policies, membership issuer | Client code |

A mobile app arrives in a later phase as a Capacitor wrapper around `apps/web`. It is not
a fourth implementation: it consumes `packages/client` exactly as the other two do. This
is the reason client logic lives in a package rather than in `apps/extension`, and it is
why `apps/web` must stay statically buildable.

## 4. Setup and commands

```
pnpm install                      # install all workspaces
pnpm build                        # build every workspace
pnpm lint                         # eslint + prettier check across the repo
pnpm test                         # vitest across the repo
pnpm format                       # write prettier formatting
```

Package manager is **pnpm** with workspaces. There is no Turborepo; root scripts fan out
with `pnpm -r`.

Not built yet, so the commands do not exist either: `pnpm --filter extension dev` and
`pnpm --filter web dev`. Add them to this list in the PR that makes them real, not before —
a command listed here is a promise that it runs.

## 5. Language rules

This project is written in **plain JavaScript. There is no TypeScript.**

- Do not create `.ts` or `.tsx` files. Do not add a `tsconfig.json`. Do not add type
  annotations to `.js` files or `lang="ts"` to Svelte components.
  - The one exception: WXT's own config file. Prefer `wxt.config.js`; if WXT refuses to
    load it, `wxt.config.ts` is accepted as tooling config, not as project source. WXT's
    generated `.wxt/` directory is a build artifact — never edited, never committed.
- ESM only. `import`/`export`, never `require`.
- Named exports. No default exports, except `.svelte` components.
- One file, one responsibility. A file past roughly 150 lines is a signal to split it.
- Early returns, shallow nesting. Prefer a good name over a comment; comments explain
  *why*, never *what*.
- No abbreviated identifiers. Write `event`, `duration`, `element` — not `e`, `d`, `el`.
- Keep modules small and composable. Prefer plain functions over classes.

## 6. Validation at boundaries

There is no type checker, so correctness is enforced at runtime, at the edges.

`packages/protocol` defines every schema using **valibot**. Validate:

- every payload sent to the relay,
- every payload received from the relay,
- every message crossing content script <-> background,
- every value read out of the host page's DOM.

Never swallow a validation failure silently. Either handle it explicitly or surface it.
Data that has not been validated does not get to travel further into the system.

## 7. Dependency policy

**Ask before adding any dependency.**

Every kilobyte in the content script is paid on every page the user visits. In the
extension specifically: no UI framework beyond Svelte, no date library, no
general-purpose utility library (lodash and friends).

Dependency direction is one-way and must stay that way:

```
apps/*             ->  packages/*
packages/client    ->  packages/protocol      (only this direction)
packages/adapters  ->  packages/protocol      (only this direction)
packages/protocol  ->  nothing internal
```

`packages/adapters` does not know the extension exists. `packages/client` does not know
which app is hosting it — the platform's storage and its UI are injected as ports.
`packages/protocol` does not know a browser exists.

## 8. Security and privacy

- MV3 host permissions stay minimal. Adding a new permission requires approval.
- The Supabase `service_role` key never appears in client code — anon key on the client,
  `service_role` only inside the edge function.
- `.env` files are never committed.
- User content goes to the relay and nowhere else. No analytics, no telemetry, no error
  reporting service without an explicit decision.

## 9. Git and pull requests

- One PR, one concern.
- Commit messages are written in English, with a light touch. Humour is welcome;
  being uninformative is not — the subject line still has to say what actually
  changed. Keep the subject short, put the detail in the body.
- **A PR that changes behavior updates the relevant `AGENTS.md` in the same PR.**
- Never commit: `node_modules/`, `.wxt/`, `build/`, `dist/`, `.env*`.

## 10. Working agreement

After making changes, run `pnpm lint` and `pnpm test`, plus the build of the app you
touched. Report failures honestly rather than working around them.

**Stop and ask** before:

- adding a dependency,
- adding a host permission or MV3 permission,
- making a breaking change to a `packages/protocol` schema,
- doing anything that conflicts with a non-negotiable in section 2.

## 11. On this file

`AGENTS.md` is the single source of truth. `CLAUDE.md` and
`.github/copilot-instructions.md` are symlinks to it and are never edited separately.

Keep instructions here concrete and verifiable — commands that run, rules that can be
checked. Generic software advice does not belong in this file.
