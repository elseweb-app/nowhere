# AGENTS.md — relay

The **reference relay** implementation: a Supabase edge function plus its database
migrations and RLS policies. Read the root `AGENTS.md` first.

## The point of this directory

ElseWeb is federated. This relay is *one* implementation of a contract, not the
architecture. Anyone should be able to run their own relay and have the extension talk
to it by changing a URL in the extension's settings.

That has one consequence that governs everything here:

> **The HTTP contract is the product. Supabase is an implementation detail.**
> Nothing Supabase-specific may leak into the contract — not a header, not an id format,
> not an error shape, not an auth mechanism only Supabase can provide.

If a change would make the contract harder for a non-Supabase relay to implement, it is
the wrong change.

## Layout

The relay is a portable core plus thin bindings, so that "Supabase is an implementation
detail" is a structural fact rather than an intention:

| Path | Role |
|---|---|
| `src/` | The whole relay: verification, policy, quotas, feed, routing. Plain JS, Web-standard `Request`/`Response`, no Supabase, no framework |
| `src/store.js` | The storage port. Injected, never constructed inside the core |
| `supabase/` | The deployment binding: Deno edge function, the port over Postgres, migrations |
| `test/` | An in-memory store and a `node:http` server, so the end-to-end test runs in vitest with no Docker and no Supabase account |

The core must never import anything from `supabase/`. If it needs to, the port is missing
a method — add it to the port, not a special case to the core.

`test/e2e.test.js` depends on `packages/client`, which is why `@elseweb/client` is a
**devDependency** here. That is test-only and does not reverse the dependency direction in
root `AGENTS.md` section 7: nothing in `src/` may import a client.

## The contract

The endpoints, payloads, verification order, policy document and rejection codes are
specified in `packages/protocol/SPEC.md`. This directory implements that spec; it does
not define it and does not invent its own payload shapes.

Rules:

- Every request body is validated against the protocol schema before anything touches
  the database. Reject invalid input with a clear error; never partially accept.
- Page identity arrives already normalized by the client, but the relay validates it and
  never re-derives it differently.
- Responses are the protocol's shapes, and nothing more. No leaking database column
  names, internal ids, or Postgres error text.
- Errors use the rejection codes from the spec, each with the extra fields that code
  is defined to carry. A bare `400` is not conformant: a client that cannot tell the
  cases apart will either retry forever or give up on a recoverable error.
- The policy document is served and kept truthful. A client that reads it and complies
  must not then be rejected — a stale policy document is a real bug, not cosmetic.
- Changing the contract means changing `packages/protocol` and the published standard in
  `apps/web` in the same PR. See the breaking-change rule in
  `packages/protocol/AGENTS.md`.

## Anti-flood: this is where policy lives

Keys are free to create, so identity alone carries no weight. The spec gives us the
mechanisms; the numbers are ours, and they are **configuration, never literals in
code**.

- Keep a record per `pubkey`: first seen, share count, last share, reports, tier.
- A new key sits in the lowest tier — small quota, high required proof-of-work.
  Tier rises with age and a clean record; quota rises and difficulty falls with it.
- Enforce quota per `pubkey` **and** per `(pubkey, page_id)`. Content is page-scoped,
  so a per-page cap is what actually bounds a flood, and it is nearly free to apply.
- Verify schema, freshness, id, signature and proof-of-work **before** any quota
  lookup, in the order the spec gives. An unauthenticated caller must not be able to
  cause database work.
- Every listing endpoint returns bounded, diversified results: one `pubkey` must not be
  able to occupy an unbounded share of any response.
- **The feed is where page-scoping stops helping.** A page query is naturally narrow; a
  feed is cross-page by definition, so the per-`(pubkey, page_id)` quota does not
  constrain it at all. The feed needs its own volume and diversity bounds, plus the
  attestation gate below.
- Votes are served raw as well as aggregated. An aggregate nobody can recount is an
  aggregate this relay could have invented, and in a federation that has to be checkable
  from outside.

None of this prevents Sybil attacks — nothing can, in a permissionless network. It
raises cost and bounds damage. See Appendix A of the spec before changing any of it.

## Database

- Migrations are forward-only and each one is reviewable on its own. Never edit a
  migration that has already been applied — add a new one.
- **RLS is mandatory.** Every new table has row-level security enabled and explicit
  policies written in the same migration that creates it. A table without policies is a
  bug, not a to-do.
- Keep the schema close to the protocol's shapes so mapping stays trivial.

## Membership issuer

This relay also issues the `membership` attestation that gates ElseWeb's feed.
It is an ordinary issuer-signed claim per §8 of the spec, and that shape is the whole
point: any third party can verify it with the issuer's public key, and any client can
choose a different trusted-issuer list — or none — and get a different feed from the
same network. A private members table that only we can check would make this relay
structurally privileged, which §1 of the spec forbids.

- An attestation states **membership, not identity**. Never put a name, an email, a
  payment reference or any other personal data in one. Payment records stay in the
  account system and never touch the network.
- Attestations are short-lived and reissued while membership holds. Revocation is by
  simply not reissuing, which is what makes a refund, a chargeback or an abuse finding
  take effect without a revocation list anyone must be able to reach.
- Payment raises the cost of a Sybil fleet sharply but does not remove it — stolen cards
  cost an attacker nothing and accounts resell. Quotas, proof-of-work, ranking and
  diversity stay in force underneath the gate. See Appendix A.3 of the spec.

## Keys and secrets

- The `service_role` key exists only inside the edge function's environment. It never
  appears in client code, in a build artifact, or in this repo.
- The **issuer signing key** is held with the same care as `service_role`. Whoever holds
  it can mint memberships, so it never leaves the function environment and never appears
  in a migration, a log line, or a response body.
- The anon key is the only key clients see.
- `.env` files are not committed. Document required variables by name in the local
  README, never with real values.

## Running your own relay

Keep this true and keep it documented: implementing the endpoints listed in the contract
is sufficient to run a relay the extension can use. No Supabase account required, no
part of this directory required.

## Verification

Run the edge function locally against a local Supabase instance. Confirm:

1. A valid payload is stored and returned by a subsequent fetch for the same page
   identity.
2. An invalid payload is rejected without a partial write.
3. RLS actually blocks a read/write it is supposed to block — test with the anon key,
   not the service role.
