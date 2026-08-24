# AGENTS.md — nowhere

Instructions for any coding agent working in this repository. This file is
tool-agnostic on purpose: no vendor-specific syntax, no file-reference macros, no XML
tags. It should read the same to every model and every editor.

Nested `AGENTS.md` files exist under `apps/*`, `packages/*` and `relay/`. The nearest
one to the file you are editing wins; it adds to this file rather than replacing it.

---

## 1. What this is

**ElseWeb** is a federated protocol for a social layer over the existing web, plus
its reference implementations. This repository's job is narrow: **develop the
protocol, and keep its documentation accurate.** End-user products built on top of
it — including the first one already live — are out of scope here and live in
their own repositories; they are just consumers of `packages/protocol` and
`packages/client` like anyone else's client would be.

What this repo ships:

- **The protocol** (`packages/protocol`) — the normative wire contract.
- **A reference relay** (`relay/`) — the MVP binding is a Supabase edge function,
  but the HTTP contract is written to be a **standard** anyone can implement and
  self-host. Supabase is the reference implementation, not the architecture.
- **A reference client** (`packages/client`) — everything a client does that is not
  UI: identity, relay pool, publishing, reading, ranking.
- **A generic protocol client** (`apps/extension`) — a Manifest V3 Chrome extension.
  On a site with an adapter (x.com for the MVP) it shows a "share with ElseWeb"
  control next to the host's own composer; content shared through it **never
  reaches the host site** — it is written to the configured relay set, and every
  other user of the extension sees it while on the same page. Beyond that social
  surface, the extension also holds a protocol identity that can be imported from
  any other client that generated one, and can act as a bridge — talking to a
  local OpenAI-compatible endpoint (Ollama and similar) so that WebGPU/Ollama-style
  compute providers can be reached over the same protocol. That compute-bridge
  mechanism is a roadmap direction, not yet specified at the protocol level.

Flow (social sharing): `shared content -> relay -> other clients on the same page`.

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
| `apps/extension` | MV3 extension: WXT entrypoints, content script, background worker, popup/options, plain Svelte UI — the generic protocol client, including identity import and the local-endpoint compute bridge | SvelteKit, site selectors, protocol schemas, relay logic |
| `packages/protocol` | `SPEC.md` and its implementation: event schemas, canonical serialization, crypto, proof-of-work, page identity | Browser APIs, network calls, storage |
| `packages/client` | Relay pool, publishing, reading and merging, key management, ranking — everything a client does that is not UI | DOM, platform storage APIs, site selectors |
| `packages/adapters` | Per-site adapters (x.com + generic fallback) | Network calls, storage, extension internals |
| `relay/` | Reference relay: a portable core in `src/`, a Supabase binding in `supabase/`, migrations and RLS policies | Client code, anything Supabase-specific inside `src/` |

`packages/client` is platform-independent (storage and clock are injected ports) so
that any host — the extension here, or an external product in its own repo — can
consume it unchanged. That is the reason client logic lives in a package rather than
in `apps/extension`.

`relay/` is a workspace member so its tests run with everyone else's. The dependency
direction is unchanged: nothing in `relay/src` may import a client, and `@elseweb-app/client`
appears there only as a **devDependency**, for the end-to-end test that drives a real relay
over HTTP.

**The client is the first finished vertical, not the extension.** `packages/client` is
usable today by any browser application — see `packages/client/README.md`. The extension
becomes another host of it rather than the place any of it lives.

`packages/client` is published to GitHub Packages as `@elseweb-app/client`, so it is
consumable from outside this workspace too, not only via `workspace:*`. See
`packages/client/README.md` §"Install from outside this workspace" and
`.github/workflows/publish-client.yml` for how a release is cut. `packages/protocol` and
`relay/` stay unpublished workspace members — protocol is bundled into the client's
build output by esbuild, so nothing external ever needs to install it directly.

## 4. Setup and commands

```
pnpm install                      # install all workspaces
pnpm build                        # build every workspace
pnpm lint                         # eslint + prettier check across the repo
pnpm test                         # vitest across the repo
pnpm format                       # write prettier formatting
pnpm --filter extension dev       # WXT dev build of the extension (loads unpacked)
pnpm --filter extension build     # production build to apps/extension/.output
```

Package manager is **pnpm** with workspaces. There is no Turborepo; root scripts fan out
with `pnpm -r`.

`pnpm test` covers `packages/*/test`, `relay/test` and `apps/*/test`. The end-to-end
proof is `relay/test/e2e.test.js`: it starts a real HTTP relay on an ephemeral port and
drives it through the public `@elseweb-app/client` API only — no Docker, no Supabase
account, no extension. `apps/extension/test` covers the worker's own logic (admission
limits, the local-AI provider, the poll-claim-execute tick, WebRTC negotiation) the same
way — dependency-injected and browser-free; loading the unpacked build in Chrome is still
the only way to verify the popup/options UI and the manifest itself (see
`apps/extension/AGENTS.md`).

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
