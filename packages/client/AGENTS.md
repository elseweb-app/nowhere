# AGENTS.md — packages/client

Everything a client does that is not user interface: the relay pool, publishing, reading
and merging, key management, and ranking. Read the root `AGENTS.md` first, and
`packages/protocol/SPEC.md` before touching anything on the wire.

**Every host consumes this package**: the extension in this repo, and any other client —
a web app, a mobile app, a third-party product — built outside it. That is the whole
reason it exists as a package rather than living inside `apps/extension`: logic that
lives in an app has to be rewritten per host and will drift; logic that lives here is
written once.

## Platform independence

This package MUST run unchanged in an MV3 service worker or any other JavaScript host —
a SvelteKit page, a Capacitor WebView, a plain Node script.

- No DOM. No `document`, no `window`, no Svelte.
- No `chrome.*`, no `localStorage`, no Capacitor imports.
- Anything platform-specific is a **port injected by the host app**: storage, and a clock.
  Define the port as a small interface, take it as a constructor argument, and never reach
  for a global.

If you are writing a platform check (`if (chrome)`, `if (typeof window)`) in this package,
the design is wrong — that branch belongs in the host app, behind a port.

`fetch` is the one exception: it exists in all three runtimes and is the transport.

## The relay pool

A client holds a **set** of relays, each readable and/or writable, each with its cached
policy document. A single relay is a set of one. There is no single-relay code path, and
adding one is a design error — it is how the multi-relay case rots.

**Publishing.** Mine once at the highest difficulty required across the writable relays,
then submit the same event to each. Return per-relay outcomes; never collapse them into
one boolean. A relay that rejected while others accepted is information the user needs.

**Reading.** Fan out, merge, deduplicate by `id`. Because `id` is a content hash, dedupe
is free and needs no coordination. Track which relays carried an event.

**Failure is normal.** One relay being down, slow, or hostile must never fail a read. Time
each out independently and return what arrived.

**Policy disagreement.** When relays advertise different limits, construct events to the
tightest so one event satisfies all of them. Surface `ATTESTATION_REQUIRED` to the user
rather than retrying.

**A relay's own policy can take it out of scope before mining ever starts.** A relay
whose policy cannot be fetched, that does not list the event's `kind`, or that does not
list the event's protocol version is excluded from that publish and reported back as
`RELAY_UNREACHABLE`, `UNSUPPORTED_KIND` or `UNSUPPORTED_VERSION` — never allowed to abort
the broadcast to the relays that are fine. Difficulty is clamped to whatever
`pow.max_difficulty` a relay advertises, and payload size is checked against the tightest
`max_payload_bytes` before mining, not after.

**Freshness can expire during mining.** `created_at` is fixed before mining starts, and a
long search at high difficulty can push it outside every relay's freshness window before
the event is ever submitted. `publishToRelays()` (`src/publish.js`) checks this once,
against the tightest advertised window, and rebuilds with a fresh `created_at` and
re-mines exactly once if needed — never a retry loop.

## Attestation trust

`src/attestations.js` wraps protocol's `verifyAttestation()` with a client's own
trusted-issuer list (SPEC.md section 8.1): an absent or empty list trusts nobody, and the
five check-order failure reasons stay distinguishable rather than collapsing to one
boolean. `src/standing.js` folds that into `standingByPubkey` for `tallyVotes()`, using
trusted unexpired attestations and `identity_mode` — key tier and account age are not
knowable from events alone (that needs a `GET /keys/{pubkey}` per author) and are
deliberately left out rather than faked. `rankEvents()` takes a precomputed
`trustedAttestationCountByEventId` for the same reason: verification is async WebCrypto
work, and ranking itself stays a synchronous sort.

## Keys

- Generate Ed25519 keys as **extractable**. A user must be able to move their identity to
  another device. This cannot be corrected later for keys already issued.
- The private key is held through the injected storage port and never leaves the device.
  It is never sent to a relay, encrypted or not.
- Key transfer between devices follows §15 of the spec: an encrypted envelope plus a
  client-generated high-entropy transfer code. Never a short numeric PIN — a photograph of
  the QR is enough to attack the envelope offline, where expiry protects nothing.

## Ranking

Ranking lives here, not in the apps, so all three surfaces order content the same way and
a fix reaches everyone at once.

- Never raw chronological order.
- Enforce author diversity: one `pubkey` cannot dominate a view.
- Weight votes by voter standing. A raw vote count is the cheapest thing on the network to
  manufacture.
- Rank on attestations, key tier and age, engagement, and recency.

The apps decide what to show. This package decides what order it is in and how much of it
there is.

## Tests

Vitest, no browser. Relays are stubbed at the `fetch` port.

Cover at least: dedupe of the same event from several relays; a slow or failing relay not
breaking a read; mining at the maximum required difficulty across a set; per-relay publish
outcomes reported separately; and the key transfer round trip, including a wrong transfer
code failing cleanly.
