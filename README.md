# ElseWeb

**An open, federated social layer for the web that already exists.**

ElseWeb attaches conversations to ordinary web pages. It does not ask those pages to
participate, and it does not ask people to move their communities somewhere new.

```
                         ┌──────────────┐
                         │   Relay A    │
                         └──────▲───────┘
                                │
  example.com ── page identity ── ElseWeb client
                                │
                         ┌──────▼───────┐
                         │   Relay B    │
                         └──────────────┘

  example.com does not participate in this exchange.
```

> **Mastodon federates social networks. ElseWeb federates the social layer around the web
> itself.**
>
> ElseWeb doesn't ask websites to become social networks. It lets independent clients
> attach social context to the web that already exists.

**Status: experimental.** The protocol, the client and a reference relay are implemented
and tested end to end. The browser extension is not built yet. See [Status](#status).

---

## What is ElseWeb?

A web page already has a stable, globally understood identifier:

```
https://example.com/article
```

ElseWeb treats that URL — or the normalized root of a domain — as something a conversation
can be attached to. A client normalizes the URL, derives a `page_id` from it, and asks the
relays it is configured with for events carrying that `page_id`.

The website does **not** need to install ElseWeb, expose an API, add JavaScript, run a
server, create an account, or grant permission. It is not receiving ElseWeb content and it
is not storing any. Two clients that normalize the same URL the same way arrive at the same
`page_id` and therefore see each other — no central registry is consulted to make that
happen.

```
the existing web
      +
ElseWeb events
      =
a social layer over the web
```

## Why?

Billions of pages exist, and discussion about them is scattered across platforms that have
nothing to do with the page. Someone reads `news-site.com/article`, and the conversation
about it is happening on Reddit, on X, on Hacker News, in a Discord, in a group chat — or
in a comment section the site itself owns and can switch off.

The page has no portable social context.

ElseWeb asks what it would take for the web to have a social layer, rather than what it
would take to build one more social website. So the fundamental object here is not a server,
an instance, or a platform-owned post. It is a URL.

## How is this different from Mastodon / ActivityPub?

ActivityPub is good prior art and solves a real problem well. It solves a **different**
problem.

```
Mastodon / ActivityPub          ElseWeb

social servers                  existing website
      ↕                               ↑
social servers                  page/domain identity
      ↕                               ↑
users                           ElseWeb client
                                   ↙       ↘
The federated network is        relay A   relay B
itself the destination.
                                The destination is the web page.
```

Concretely:

**Websites are not instances.** `example.com` is not an ElseWeb server, and its owner does
not automatically own or administer the ElseWeb conversation about `example.com`.

**Identity is not tied to a home server.** There is no `user@instance.social`. Identity is a
keypair the user holds. Changing every relay you use changes nothing about who you are.

**Relays are infrastructure, not identity providers.** A relay stores and serves events
under its own acceptance policy. It does not issue you an account.

**No client is privileged.** The protocol names no relay and no issuer. A browser extension,
a web app, a mobile app and a third-party client are all just consumers of the same network.

This is a different architectural goal, not a claim to be better. If you want a federated
social network, ActivityPub is a mature answer. ElseWeb is aimed at the layer around pages
that already exist.

## How it works

```
User writes
    ↓
local identity            (keypair, generated on device)
    ↓
construct event           (target, kind, content, created_at)
    ↓
read relay policy         (what does this relay require?)
    ↓
Proof-of-Work             (only where the policy requires it)
    ↓
sign locally
    ↓
publish to the relay set
```

Everything on the network is a signed **event**. Sharing, replying and voting are the same
envelope with a different `kind`. An event carries its author's public key, the target it
belongs to, its content, a timestamp, a nonce, and a signature. Its `id` is a hash of its
canonical bytes, which is what makes deduplication across relays free.

Reading is the same path in reverse: derive the target, ask every readable relay, merge,
drop anything whose signature or page identity does not check out, and rank what is left.

The normative details — canonical serialization, the exact envelope, the verification order
— live in [`packages/protocol/SPEC.md`](packages/protocol/SPEC.md). **Where this README and
`SPEC.md` disagree, `SPEC.md` is normative.**

## Identity

An ElseWeb identity is an Ed25519 keypair generated on the user's own device.

```
generate keypair
      ↓
private key stays with the user
      ↓
public key identifies the author
      ↓
events are signed locally
      ↓
relay verifies the signature
```

No email, no password, no hosted authentication, no server-side account creation. The
private key is never sent to a relay, encrypted or not.

The property that matters:

```
relay A disappears
        ↓
the user still owns their identity
        ↓
the user keeps posting through relay B
```

Keys are generated **extractable** so an identity can move between devices. Transfer uses an
encrypted envelope plus a high-entropy code the client generates, which travels separately
from the envelope (`SPEC.md` §15).

**There is no key recovery.** If a user loses their key and has not exported it, that
identity is gone, along with whatever standing it had accumulated. This is a real cost of
the design and we would rather state it than bury it.

## Pages and domain communities

```
URL
 ↓
normalization        (generic rules, plus a site adapter where one exists)
 ↓
canonical page URL
 ↓
SHA-256
 ↓
page_id
```

Normalization is what makes two people land in the same conversation, so it is specified
precisely and changing it is a breaking change. Implemented today: only `http` and `https`
are accepted; scheme and host are lowercased and IDN hosts are punycoded while **path case
is preserved**; userinfo, default ports and fragments are removed; dot segments are
resolved; percent-encoding is normalized; a conservative list of tracking parameters is
stripped (any `utm_*`, plus `fbclid`, `gclid`, `gbraid`, `wbraid`, `msclkid`, `dclid`,
`yclid`, `mc_cid`, `mc_eid`, `igshid`, `ref_src`, `ref_url`, `_ga`); remaining parameters
are sorted by UTF-16 code unit; a trailing slash is significant and preserved.

So `https://EXAMPLE.com:443/post?utm_source=x&b=2&a=1#intro` and
`https://example.com/post?a=1&b=2` are the same target, while `https://example.com/foo` and
`https://example.com/foo/` are deliberately not.

A **domain community is just the normalized site root**. There is no separate event kind and
no special field for it:

```
https://example.com/            the community around the domain
https://example.com/article     that one page's discussion
```

An optional `anchor` addresses sub-content within a page — a specific post in a feed, a
specific comment — and must be derived from an identifier the site itself exposes, never
from DOM position.

## Relays

A client holds a **set** of relays, editable at any time. A single relay is the simplest
case of a set, not a different mode — there is no single-relay code path.

```
                 ┌─ relay A
client ──────────┼─ relay B
                 └─ relay C
```

**Publishing.** The client reads each writable relay's policy, mines once at the highest
difficulty the set requires, and submits the same event to every one of them. Per-relay
outcomes are returned individually and never collapsed into one boolean — a relay that
rejected while others accepted is something the user needs to know. A relay whose policy
cannot be read is excluded from the broadcast and reported, rather than failing the publish
to healthy relays.

**Reading.** The client queries every readable relay and merges. Because `id` is a content
hash, deduplication needs no coordination. Which relays carried an event is recorded and
exposed. One relay being slow, down or hostile does not fail a read.

Relays are replaceable infrastructure. The HTTP contract is the product:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/policy` | What this relay requires |
| `GET` | `/keys/{pubkey}` | What one key currently owes |
| `POST` | `/events` | Publish one event |
| `GET` | `/events?page_id=…` | A page's events, optionally narrowed by `&anchor_id=` |
| `GET` | `/events?target_id=…` | Raw vote events for one target, for independent recount |
| `GET` | `/feed?cursor=…` | This relay's feed |

The reference relay stores events in Supabase. **Supabase is not part of the ElseWeb
protocol** — it is an implementation choice of this one relay. The relay core talks to a
seven-method storage port (`relay/src/store.js`); anything that implements that port and the
HTTP contract above is a conforming relay. `relay/test/memory-store.js` is a complete
worked example of the port in about a hundred lines.

## Proof-of-Work

**This is not cryptocurrency mining.** There is no token, no coin, no blockchain, no
monetary reward, and no consensus mechanism. Proof-of-Work here is an abuse-control
primitive and nothing else.

The problem it addresses is specific. In an open publishing system, creating identities is
free and publishing is free, so one actor can produce an unbounded amount of content.
Centralized platforms answer this with account systems, CAPTCHAs, phone verification and
platform-wide bans. ElseWeb cannot assume a single global account authority exists, so it
needs a cost that anyone can verify without knowing anything about the author.

```
a person posting occasionally      an automated actor publishing at volume
        ↓                                      ↓
  a small computational cost        that cost repeats a million times
        ↓                                      ↓
  barely noticeable                  abuse gets progressively expensive
```

Difficulty is the number of leading zero bits of an event's `id`. A relay verifies it by
counting bits of a hash it already computed, which is why this works across a federation:
no shared state, no prior relationship with the author.

Difficulty is **not** a protocol constant. Each relay advertises its own requirements at
`GET /policy`, and clients read that rather than hardcoding anything. It may vary per kind
and per key — a `vote` is a smaller action than a `share`, and an established key may owe
less than a brand-new one. `GET /keys/{pubkey}` reports what a specific key currently owes.
A `POW_INSUFFICIENT` rejection carries the difficulty the relay actually wants, so a client
that guessed low recovers in one retry.

Work is bound to a **freshness window**. Because `created_at` is inside the bytes the work
commits to, an event dated outside a relay's window is rejected in either direction. Without
that, an attacker would mine offline for months and release the stockpile at once — the
stockpile *is* the flood.

**Proof-of-Work does not eliminate spam.** It raises the marginal cost of automated
publication. Nothing in a permissionless network prevents a determined, funded attacker.

## Abuse resistance is layered

PoW is one control among several, and it is not the most important one. What is actually
implemented:

| Mechanism | What it bounds |
|---|---|
| Signed events | Content cannot be attributed to a key that did not sign it |
| Proof-of-Work | Marginal cost of automated publication |
| Freshness window | Pre-computed work is worth at most one window |
| Per-key quotas | How much one key can publish at all |
| Per-`(pubkey, page_id)` quotas | How much one key can publish *on one page* — the bound that actually stops a flood, since content is page-scoped |
| Per-kind quotas | Votes counted separately from shares |
| Payload size limits | Individual event size |
| Content-hash `id` | Duplicate submissions collapse to one row |
| Relay policy | What this relay will carry at all |
| Client ranking and author diversity | What a reader actually sees |

Attestations — publicly verifiable claims about a key, verifiable by any third party holding
only public information — are specified and verified by both client and relay. **Nothing
issues them yet**; the membership issuer is not built.

The design principle underneath all of it:

> Protocol validity, relay acceptance and client visibility are three different questions.

An event can be cryptographically valid, and a relay can still refuse to store it, and
another relay can accept it, and a client can still decline to show it prominently. Keeping
those layers separate is deliberate.

## Moderation and relay policy

ElseWeb does not mean everything must be hosted everywhere.

Every relay has its own policy and may reject events, enforce quotas, set PoW requirements,
require attestations, and refuse or remove content according to its operator's judgment.
Running a relay means taking responsibility for what it carries.

The distinction that matters:

> A relay ban is local. It is not a network-wide ban.

If relay A refuses key X, that does nothing to key X's cryptographic validity elsewhere.
Another relay may decide differently. A client may also decide differently again.

```
protocol rules   →  what is a valid ElseWeb event?
relay policy     →  what will this relay carry?
client policy    →  what does this reader actually see?
```

Federation moves some policy decisions from a global platform to relay operators and
clients. It does not make those decisions disappear, and it does not solve moderation. It
changes who is making the call, and makes it possible to disagree with them without leaving
the network.

## The host website is not modified

```
example.com
    │
    │  an ordinary web page
    ▼
  browser

ElseWeb client
    │
    ├── derives page identity from the URL
    ├── queries its configured relays
    └── renders social UI locally
```

Content flows `client ↔ relay`. It never flows `client → example.com`. A client may place
ElseWeb UI visually alongside a page, but the page is not becoming an ElseWeb server and is
not told anything.

One honest cost: `page_url` travels on the wire, so the relays you publish to learn which
pages you are commenting on. Hashing does not hide this — hashes of known URLs are trivially
precomputed. Users should be told this plainly.

## Architecture

```
                 browser extension  (not built yet)
                        │
                        │
   web client ───── @elseweb/client ───── third-party client
                        │
                        │
                @elseweb/protocol
                        │
                   relay set(s)
```

The protocol names no privileged participant. The official clients are consumers of the
network like any other.

## Quick start

Requires **Node ≥ 24** (for WebCrypto Ed25519) and **pnpm 11.17.0**.

```bash
pnpm install
pnpm test      # 368 tests: protocol, adapters, client, relay, end to end
pnpm lint
pnpm build
```

### Use ElseWeb from JavaScript

```js
import { createElsewebClient } from '@elseweb/client'

const client = createElsewebClient({
  relays: ['https://relay.example.com'],
  identityStore, // { get, set, remove } — IndexedDB in a browser
})

await client.identity.getOrCreate()

await client.publishShare({
  pageUrl: 'https://example.com/',
  text: 'hello from another ElseWeb client',
})

const { threads } = await client.readPage('https://example.com/')
```

The client handles normalization, policy discovery, Proof-of-Work, canonicalization,
hashing, signing, multi-relay publication, response validation, deduplication and ranking.
A consumer supplies product data, not protocol mechanics.

See [`docs/CLIENT.md`](docs/CLIENT.md) and
[`packages/client/README.md`](packages/client/README.md).

### Run a relay

The relay core has no Supabase in it and runs on the Web-standard `Request`/`Response`
objects, so it works under Node and Deno alike. See
[`docs/RUNNING_A_RELAY.md`](docs/RUNNING_A_RELAY.md).

## Repository structure

| Path | Contains |
|---|---|
| `packages/protocol` | `SPEC.md` and its implementation: event schemas, canonical serialization, Ed25519/SHA-256 crypto, page identity, Proof-of-Work, attestations, key transfer. No browser APIs, no network, no internal dependencies |
| `packages/client` | Everything a client does that is not UI: identity, relay pool, HTTP transport, policy discovery, the publish pipeline, reading and merging, ranking. No DOM, no platform storage |
| `packages/adapters` | Per-site adapters (x.com and a generic fallback) that supply a canonical target URL and anchor id for sites where generic normalization is not enough |
| `relay/src` | The reference relay: verification, policy, quotas, feed, routing. Portable, storage-agnostic |
| `relay/supabase` | The reference relay's Supabase binding: edge function, storage port over Postgres, migrations with RLS |
| `relay/test` | An in-memory store, a `node:http` bridge, and the end-to-end proof |
| `apps/extension`, `apps/web` | Not built yet |

Dependency direction is one-way: `apps → packages`, `packages/client → packages/protocol`,
`packages/adapters → packages/protocol`, and `packages/protocol` depends on nothing internal.

## Protocol specification

[`packages/protocol/SPEC.md`](packages/protocol/SPEC.md) is the normative wire contract:
canonical serialization, the event envelope, target identity, Proof-of-Work, attestations,
endpoints, the policy document, multi-relay behavior, key transfer and rejection codes.
Appendix A records the threat model and the alternatives that were rejected, so a later
reader does not have to rediscover them.

The vectors in `packages/protocol/test/vectors/` are published commitments. Anyone writing a
second relay or client checks their implementation against them. Adding a vector is routine;
changing one is a breaking change.

## Security and threat model

Appendix A of `SPEC.md` is the long version. The short version:

- **Sybil attacks are not solved.** Nothing solves them in a permissionless network. PoW,
  quotas, attestations and ranking raise cost and bound damage.
- **Relays see your browsing on pages where you participate.** Stated above; not mitigated
  by hashing.
- **`identity_mode` is a declaration, not a control.** A relay cannot distinguish an
  `ephemeral` key from a new persistent one. No security property depends on it.
- **A private key is the whole identity.** No recovery, no rotation without losing accrued
  standing. Anyone who captures both a transfer envelope and its code gains that identity
  permanently.
- **Aggregates are auditable on purpose.** Vote totals are served alongside the raw vote
  events, so a relay that misreports can be caught from outside.

## Development

```bash
pnpm install
pnpm test              # vitest across packages/*/test and relay/test
pnpm lint              # eslint + prettier
pnpm format
pnpm build
```

Plain JavaScript throughout — no TypeScript, ESM only, named exports. `AGENTS.md` at the
repository root is the contributor guide, and nested `AGENTS.md` files under `packages/*`
and `relay/` add to it.

The end-to-end proof is `relay/test/e2e.test.js`: it starts a real HTTP relay on an
ephemeral port and drives it through the public `@elseweb/client` API only — no Docker, no
Supabase account, no extension.

## Status

Experimental. Implemented and tested:

- The protocol: schemas, canonicalization, crypto, page identity, PoW, attestations, key transfer
- The client: identity, relay pool, transport, policy discovery, publishing, reading, threading, ranking
- The reference relay: the full verification pipeline, policy, quotas, feed, and a Supabase binding
- Site adapters for x.com and a generic fallback

Not built yet:

- **The browser extension.** It becomes another host of `@elseweb/client`; none of it changes the packages.
- **The membership issuer.** Attestations verify, but nothing mints them.
- **`apps/web`.** No landing page, docs site or feed UI.
- **npm publishing.** Packages are consumed from this workspace or as a git dependency.
- **Key tier and age in ranking.** Needs a per-author `/keys/{pubkey}` call the client does not currently make.
- **Event retention.** Nothing prunes stored events.

## License

Not yet chosen.
