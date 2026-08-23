# AGENTS.md — packages/protocol

**This package is the federation contract.** What is defined here is what every relay
implementation — ours and anyone else's — has to agree on. Treat it accordingly: it is
the slowest-moving, most carefully changed code in the repo.

Read the root `AGENTS.md` first.

## Purity

This package is pure data and pure functions.

- No browser APIs. No `chrome.*`, no `document`, no `window`, no `fetch`.
- No Supabase, no HTTP client, no transport of any kind.
- No dependency on any other workspace package.

If a function here needs to know how something is sent, it is in the wrong package.

## What lives here

- **Payload schemas** — the shape of a shared item as it travels to and from a relay.
  Defined with valibot.
- **Page identity** — the function that turns a URL into the id two users must both
  arrive at in order to see each other's content on the same page. This is the single
  hardest correctness problem in the product: normalization must strip fragments,
  tracking parameters and other noise, while keeping parameters that genuinely identify
  a distinct page. Every normalization rule needs a test with a real-world URL.
- **Identity and signing** — how an author is represented and how a payload is attested.
- **Schema version** — the version field carried by every payload.

## Changing a schema

- **Adding a field is allowed** if it is optional and older readers ignoring it still
  behave correctly.
- **Removing a field, renaming it, narrowing its type, or changing its meaning is a
  breaking change.** It requires a version bump, and you must **stop and ask** before
  making one. Someone else's relay may already be speaking the old version.
- Never make a validation rule stricter without treating it as breaking — data that used
  to be accepted would start being rejected.
- Every schema change updates the relay standard documentation in `apps/web` and the
  contract in `relay/AGENTS.md` in the same PR.

## Tests

This is the one package where test coverage is not optional. Every schema gets a test
for both an accepted and a rejected payload. Every URL normalization rule gets a test.
