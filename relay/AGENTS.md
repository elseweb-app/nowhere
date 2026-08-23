# AGENTS.md — relay

The **reference relay** implementation: a Supabase edge function plus its database
migrations and RLS policies. Read the root `AGENTS.md` first.

## The point of this directory

everywhere.app is federated. This relay is *one* implementation of a contract, not the
architecture. Anyone should be able to run their own relay and have the extension talk
to it by changing a URL in the extension's settings.

That has one consequence that governs everything here:

> **The HTTP contract is the product. Supabase is an implementation detail.**
> Nothing Supabase-specific may leak into the contract — not a header, not an id format,
> not an error shape, not an auth mechanism only Supabase can provide.

If a change would make the contract harder for a non-Supabase relay to implement, it is
the wrong change.

## The contract

The edge function exposes the endpoints the extension needs: publishing a shared item,
and fetching the items for a page identity. Each endpoint's method, request shape and
response shape is defined by the schemas in `packages/protocol` — the relay does not
invent its own payload shapes.

Rules:

- Every request body is validated against the protocol schema before anything touches
  the database. Reject invalid input with a clear error; never partially accept.
- Page identity arrives already normalized by the client, but the relay validates it and
  never re-derives it differently.
- Responses are the protocol's shapes, and nothing more. No leaking database column
  names, internal ids, or Postgres error text.
- Errors are a stable, documented shape. Other relays must be able to produce them.
- Changing the contract means changing `packages/protocol` and the published standard in
  `apps/web` in the same PR. See the breaking-change rule in
  `packages/protocol/AGENTS.md`.

## Database

- Migrations are forward-only and each one is reviewable on its own. Never edit a
  migration that has already been applied — add a new one.
- **RLS is mandatory.** Every new table has row-level security enabled and explicit
  policies written in the same migration that creates it. A table without policies is a
  bug, not a to-do.
- Keep the schema close to the protocol's shapes so mapping stays trivial.

## Keys and secrets

- The `service_role` key exists only inside the edge function's environment. It never
  appears in client code, in a build artifact, or in this repo.
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
