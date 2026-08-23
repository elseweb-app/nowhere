# AGENTS.md — packages/client

Everything a client does that is not user interface: the relay pool, publishing, reading
and merging, key management, and ranking. Read the root `AGENTS.md` first, and
`packages/protocol/SPEC.md` before touching anything on the wire.

**Three hosts consume this package**: the extension, the website, and — in a later phase —
the Capacitor mobile app. That is the whole reason it exists. Logic that lives in an app
has to be written three times and will drift; logic that lives here is written once.

## Platform independence

This package MUST run unchanged in an MV3 service worker, in a SvelteKit page, and in a
Capacitor WebView.

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
