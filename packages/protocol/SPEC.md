# ElseWeb relay protocol — v1 (draft)

Normative specification of the wire contract between a client and a relay.

This document is the source of truth for the federation contract. Any published page
describing the relay standard, wherever it ends up hosted, is derived from this file,
and the two are updated in the same pull request.

**Implementing the endpoints in §10 is sufficient to run a relay.** Nothing in this
document depends on Supabase, on our reference implementation in `relay/`, or on
ElseWeb being involved at all.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used in the RFC 2119 sense.

---

## 1. Scope and design principle

The protocol defines **mechanisms, not policy.**

It contains no numeric thresholds — no proof-of-work difficulty, no quota, no tier
definition, no price. Those are each relay's own configuration. What the protocol defines
is the structure that makes a policy expressible, discoverable, and actionable by a
client: the event envelope, the policy document (§11), and the rejection codes (§16).

Two consequences that govern the whole design:

- A relay MUST be free to be stricter or looser than any other relay without breaking
  clients.
- **No participant is privileged by the protocol.** ElseWeb's own relay is a relay
  like any other; its feed policy is expressed with the same mechanisms available to
  everyone, and a different client can make different choices (§13).

## 2. Cryptographic primitives

| Purpose | Algorithm |
|---|---|
| Signature | Ed25519 |
| Hash | SHA-256 |
| Key derivation (key transfer only) | PBKDF2-HMAC-SHA256 |
| Symmetric cipher (key transfer only) | AES-256-GCM |
| Binary encoding | Lowercase hexadecimal |

All of these are reachable through WebCrypto in every runtime we target — extension, web,
and Capacitor-wrapped mobile — so a conforming client needs no cryptography dependency.

`pubkey` is a 32-byte Ed25519 public key, hex-encoded (64 characters).
`sig` is a 64-byte signature, hex-encoded (128 characters).
`id` is a 32-byte SHA-256 digest, hex-encoded (64 characters).

**Private keys MUST be generated as extractable.** A user must be able to move their
identity between devices (§15). A key that cannot leave the runtime that created it
strands its owner permanently, and the mistake is unfixable after the fact: keys already
issued to users cannot be retroactively made extractable.

## 3. Canonical serialization

Signatures and proof-of-work are computed over the same byte sequence. If two
implementations serialize the same event differently, signatures fail to verify and the
cause is very hard to find. Canonicalization is therefore normative.

- The canonical form is **JSON Canonicalization Scheme, RFC 8785** (JCS): object keys
  sorted by UTF-16 code unit, no insignificant whitespace, UTF-8 output.
- The canonical form covers every field of the event **except `id` and `sig`**, which are
  omitted entirely (not set to `null`).
- Optional fields that are absent MUST be omitted, never serialized as `null`. A field
  present with `null` and a field absent are different canonical forms, and therefore
  different events.
- **All numbers MUST be integers.** No floating point value appears anywhere, which
  removes RFC 8785's number-formatting edge cases entirely.
- Canonicalization MUST NOT alter string content. Clients SHOULD apply Unicode NFC
  normalization to human-entered text *before* constructing the event, so that the same
  visible text produces the same bytes.

Then:

```
canonical_bytes = JCS(event without id and sig)
id              = hex(SHA-256(canonical_bytes))
sig             = hex(Ed25519-Sign(privkey, SHA-256(canonical_bytes)))
```

Implementations MUST ship test vectors: hand-written events with their expected canonical
bytes, `id`, and `sig`. Anyone writing a second relay validates against these.

## 4. The event envelope

Every object on the network is an **event**. Sharing, replying and voting differ only in
`kind` and in the kind-specific fields.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | integer | yes | Protocol version. `1` for this document |
| `kind` | string | yes | `"share"`, `"reply"` or `"vote"` (§5) |
| `pubkey` | hex string | yes | Author's Ed25519 public key |
| `created_at` | integer | yes | Unix seconds. Binds freshness (§7.2) |
| `identity_mode` | `"persistent"` \| `"ephemeral"` | yes | See §9 |
| `nonce` | integer | yes | Varied during mining (§7.1) |
| `attestations` | array | yes | Publicly verifiable claims about `pubkey` (§8). MAY be empty |
| `page_id` | hex string | by kind | Target identity, the join key (§6) |
| `page_url` | string | by kind | The canonical target URL `page_id` was derived from (§6) |
| `anchor` | object | no | Sub-content within the page, `{ "id": "<string>" }` (§6) |
| `parent_id` | hex string | by kind | Direct parent event |
| `root_id` | hex string | by kind | Thread root event |
| `target_id` | hex string | by kind | Event being voted on |
| `content` | object | yes | Kind-specific payload |
| `id` | hex string | yes | Per §3. Not part of the canonical form |
| `sig` | hex string | yes | Per §3. Not part of the canonical form |

Schemas are a discriminated union on `kind`. A field not required by a kind MUST be
absent, not present-and-empty.

A relay MUST verify, in this order, and MUST reject on the first failure:

1. `v` is a protocol version the relay speaks — otherwise `UNSUPPORTED_VERSION`;
2. `kind` is a kind the relay accepts — otherwise `UNSUPPORTED_KIND`;
3. the event matches the schema for its kind — otherwise `SCHEMA_INVALID`;
4. the encoded size is within the relay's limit — otherwise `PAYLOAD_TOO_LARGE`;
5. `created_at` is inside the freshness window — otherwise `STALE_TIMESTAMP`;
6. `id` equals the hash of the recomputed canonical bytes — otherwise `SCHEMA_INVALID`;
7. `sig` verifies against `pubkey` — otherwise `SIGNATURE_INVALID`;
8. every attestation verifies and is unexpired — otherwise `ATTESTATION_INVALID`;
9. the relay's attestation requirements are met — otherwise `ATTESTATION_REQUIRED`;
10. `id` carries sufficient work — otherwise `POW_INSUFFICIENT`;
11. the author is within quota — otherwise `QUOTA_EXCEEDED`.

Version and kind are checked first so a relay never rejects an event it simply does not
understand with a code claiming the event was malformed. Signature and proof-of-work are
checked before any quota lookup, so an unauthenticated caller cannot cause database work.

## 5. Event kinds

### 5.1 `share`

Requires `page_id` and `page_url`. `anchor` is present when the share targets sub-content
within the page (§6).

`content` is `{ "text": "<string>" }`.

`content.media` is **reserved** and MUST be absent in v1. It is an optional field, so
introducing it later is not a breaking change. Appendix A.6 records what it has to look
like to survive federation.

### 5.2 `reply`

Requires `parent_id`, `root_id`, `page_id` and `page_url`. `content` is
`{ "text": "<string>" }`.

- `parent_id` is the event replied to, which MAY itself be a reply.
- `root_id` is the `share` at the top of the thread, so a whole thread is one query.
- `page_id`, `page_url` and `anchor` are denormalized from the root, so a page query
  returns the thread along with it. They MUST match the root's values.

A relay MAY cap thread depth and MAY reject a reply whose parent it does not hold.
A client MUST render a reply whose parent is missing as an orphan rather than dropping
it — in a federation the parent may live on a relay the reader does not use.

### 5.3 `vote`

Requires `target_id`. `content` is `{ "value": 1 }` or `{ "value": -1 }`.

- At most one vote per `(pubkey, target_id)` is effective. A later `created_at` replaces
  an earlier one; on equal `created_at` the lexicographically greater `id` wins. This tie
  rule is normative so that independent relays converge on the same result.
- A relay MUST expose aggregate counts and MUST also serve the underlying vote events, so
  a client can recount and detect a relay that misreports. An aggregate nobody can audit
  is an aggregate a relay can invent.
- Clients MUST NOT rank by raw vote count. Votes are the cheapest event to mass-produce
  and therefore the highest-leverage target for a Sybil attack; weight them by voter tier
  and attestations (§14).

## 6. Target identity

Two users looking at the same thing MUST derive the same target identity, or they cannot
see each other. This is the product's core correctness requirement.

A target has three levels:

| Level | Where the event was made | What it binds to |
|---|---|---|
| 0 | A social network's main feed | The site root — `https://x.com/`, not `/home` |
| 1 | A piece of content reachable by URL | That content's normalized URL |
| 2 | Sub-content inside that content — a post in a thread, a comment | The normalized URL plus the sub-content's id |

Three fields express it:

- **`page_url`** — the canonical target URL, after normalization. Carried on the wire
  because `page_id` is a hash: a feed cannot show *where* something was shared, and a
  reader cannot link back, from a hash alone.
- **`page_id`** — `hex(SHA-256(page_url))`. The join key.
- **`anchor`** — optional, `{ "id": "<string>" }`. Present at level 2. It is part of the
  join key *and* it is what tells a client where on the page to render.

### 6.1 Who produces the canonical URL

Normalization has a generic part and a site-specific part, and they live in different
places.

The generic part is defined here and applies everywhere. In order:

1. Only `http` and `https` are accepted. Any other scheme is rejected, not normalized.
2. Scheme and host are lowercased. A trailing dot on the host is removed. An
   internationalized host is converted to its ASCII (punycode) form, so that a user who
   typed the unicode name and one who typed the encoded name land on the same target.
   Path case is **preserved** — paths are case-sensitive on most origins.
3. Userinfo (`user:pass@`) is removed.
4. The default port for the scheme is removed; any other port is kept.
5. The fragment is removed, empty or not.
6. Dot segments in the path are resolved. An empty path becomes `/`.
7. Percent-encoding is normalized: unreserved characters are decoded, everything else keeps
   its escape with uppercase hex digits.
8. Tracking parameters are removed: any parameter whose name begins with `utm_`, plus
   `fbclid`, `gclid`, `gbraid`, `wbraid`, `msclkid`, `dclid`, `yclid`, `mc_cid`, `mc_eid`,
   `igshid`, `ref_src`, `ref_url`, `_ga`. The list is deliberately conservative: a parameter
   that is tracking on one site and meaningful on another belongs to that site's adapter,
   not here.
9. A parameter given without a value is normalized to `name=`, so `?a` and `?a=` are the
   same target.
10. Remaining query parameters are sorted by name, then by value, **comparing UTF-16 code
    units** — the same ordering §3 uses for object keys. Collation must not be
    locale-aware: `?B=1&a=2` sorts `B` before `a`, and an implementation that sorted them
    the other way would silently stop agreeing with everyone else. Sorting exists so that
    parameter order cannot split the network; an ambiguous sort would defeat it. A query
    left empty loses its `?`.
11. A trailing slash is significant and preserved. `…/foo` and `…/foo/` are different
    targets, because on many origins they genuinely are.

`http` and `https` are different targets. So are two paths differing only in case.

The executable form of these rules is `test/vectors/target.json`. Where prose and vectors
could be read differently, the vectors win — they are what a second implementation is
checked against.

The site-specific part cannot be. Nothing generic can know that `x.com/home` and
`x.com/explore` are both the site's main feed and must collapse to `https://x.com/`, while
`x.com/user/status/123` must not. That is site knowledge, so a **site adapter** supplies
the canonical target URL and the anchor id, and this package normalizes what it is given.

A conforming client that has no adapter for a site falls back to the generic normalization
of the current URL, with no anchor. It will not agree with an adapter-equipped client about
level 0 pages; it will agree about level 1.

### 6.2 Anchor ids

An anchor id MUST be derived from a durable identifier the host site itself exposes —
the id in a permalink, a post id, a comment id. It MUST NOT be derived from DOM position,
element index, ordering, or generated class names. A DOM-derived anchor is not stable
across re-renders and is not stable between two users, which means the two of them silently
stop sharing a target.

An anchor id is opaque to the protocol and to relays. Only the adapter that produced it
knows how to find the thing again.

### 6.3 Verification and opacity

A relay MUST treat `page_id` as opaque. It MUST NOT re-derive, rewrite, or interpret it —
re-deriving would couple every relay to one normalization version, and a client running a
different version would simply be rejected.

Clients SHOULD verify that `page_id` equals the hash of `page_url` when rendering, and
SHOULD treat a mismatch as untrustworthy. This catches a forged pairing without coupling
relays to normalization.

### 6.4 Changing normalization is breaking

Changing either the generic rules or an adapter's canonical-URL rule changes which users
can see each other, which partitions the network. It is a breaking protocol change and
requires a version bump.

### 6.5 Privacy cost, stated plainly

`page_url` puts the full URL of every page a user shares on in front of every relay they
publish to. This is a real cost and it is not softened by `page_id` being a hash: hashes of
known URLs are trivially precomputed, so the hash never provided meaningful protection.
Users MUST be told that sharing on a page reveals that page to the relays they publish to.

## 7. Proof of work

### 7.1 Definition

Difficulty is the number of leading zero **bits** of the `id` digest. A client mines by
varying `nonce` and recomputing `id` until the required difficulty is met.

Verification is stateless: counting leading zero bits of a value the relay already
computed. A relay can verify work from an author it has never seen, which is what makes
this usable across a federation.

Proof-of-work MUST NOT be required on read paths.

### 7.2 Freshness — why the window exists

Without a freshness constraint, proof-of-work accomplishes nothing: an attacker mines
events offline for months and releases them at once. The stockpile *is* the flood.

Because `created_at` is inside the canonical bytes, it is committed to by `id` and
therefore by the work. A relay MUST reject an event whose `created_at` lies outside its
advertised freshness window, in either direction. Pre-computed work is then worth at most
one window.

Clients SHOULD mine immediately before submitting, and MUST NOT retain a mined event
beyond the window and resubmit it.

A relay MAY additionally require its own rotating challenge value. This is optional by
design: a relay-specific challenge makes one mined event valid at one relay only, which
defeats the multi-relay broadcast in §12.

### 7.3 Adaptive difficulty

Required difficulty MAY vary per author and per kind — high for an unknown key, low or
zero for an established one; a `vote` is a smaller action than a `share` and MAY cost
differently. Discovery:

- `GET /policy` (§11) advertises what an **unknown** key must pay, per kind.
- `GET /keys/{pubkey}` (§10) returns what that key currently must pay.
- A `POW_INSUFFICIENT` rejection carries `required_difficulty`, so a client that guessed
  low recovers in a single retry.

### 7.4 Client obligations

Mining MUST be cancellable and MUST report progress. A client MUST stop at a bounded
effort and surface a clear error rather than appearing to hang.

## 8. Attestations

An attestation is a publicly verifiable claim about `pubkey`, carried by the event. It is
how a client or relay distinguishes an account someone invested in from one generated a
second ago.

An attestation MUST be verifiable by any third party holding only public information. A
claim nobody outside the issuing relay can check is not an attestation; it is that
relay's private database, and it does not belong on the wire.

### 8.1 `issuer-signed`

```json
{
  "type": "issuer-signed",
  "issuer": "<hex pubkey of the issuer>",
  "claim": "membership",
  "subject": "<hex pubkey being attested>",
  "issued_at": 0,
  "expires_at": 0,
  "sig": "<issuer signature over the canonical attestation without sig>"
}
```

- `subject` MUST equal the event's `pubkey`.
- The attestation is signed the same way an event is: `sig` covers
  `SHA-256(canonical bytes)` of the attestation without its `sig`, using the canonical
  form of §3. It is not signed over the raw bytes.
- Verification needs only public information — no call to the issuer, no shared secret.
- Whether an issuer is *trusted* is not a protocol question. Each client and relay keeps
  its own trusted-issuer list (§13). An empty or absent list trusts nobody; that is the
  safe default and MUST NOT be read as trusting everybody.

**Check order is normative**, because the reason a verifier reports changes what a client
does next. Verify in this order and return the first failure:

1. `type` is one this verifier supports — otherwise `unsupported_type`;
2. `sig` verifies against `issuer` — otherwise `signature_invalid`;
3. `issuer` is in the trusted list — otherwise `untrusted_issuer`;
4. `expires_at` is in the future — otherwise `expired`;
5. `subject` matches the event's `pubkey` — otherwise `subject_mismatch`.

Signature is checked before trust so that "cryptographically valid but not trusted here"
is a distinguishable outcome — the same attestation may be perfectly good at another
relay. Trust is checked before expiry so that a client is not told to go refresh an
attestation from an issuer that would be rejected anyway.

**Expiry is exclusive**: `now == expires_at` is expired.

**An attestation states membership, not identity.** It MUST NOT carry a name, an email
address, a payment reference, or any other personal data. Whatever the issuer did to
decide the claim — a payment, an invitation, a manual review — stays entirely off the
network.

**Revocation is by expiry.** Attestations SHOULD be short-lived and reissued while the
underlying condition holds, so that a refund, a chargeback, or an abuse finding takes
effect by simply not reissuing. An issuer MAY additionally publish a revocation list; a
verifier MUST NOT depend on being able to reach one.

### 8.2 `host-account` — reserved

Reserved for v2: proving control of an account on the host site by publishing the key's
fingerprint in a profile bio or public post, at `proof_url`, verifiable by anyone. Its
effect is that a Sybil identity costs whatever an account on that platform costs.

Clients MUST tolerate attestation types they do not recognize by ignoring them, so new
types do not require a version bump.

## 9. Identity modes

- **`persistent`** — the default. Reputation accrues to this key; key age, quota tiers and
  attestations are built on it.
- **`ephemeral`** — a single-use key. Relays SHOULD apply their lowest quota; clients
  SHOULD rank it lowest.

An ephemeral key cannot hold an attestation, since an attestation binds to a subject key
that must persist to be worth issuing. Ephemeral events therefore never appear in an
attestation-gated feed (§13) — this follows from the design rather than being enforced.

**A relay cannot distinguish an `ephemeral` key from a newly created persistent one.** The
field is an honest client's declaration, not a security control. An attacker who omits it
is simply treated as a new key, which is already the lowest tier. No security property may
depend on this field.

Users MUST be told that a persistent key lets a relay link all of their events together.

## 10. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/policy` | Policy document (§11) |
| `GET` | `/keys/{pubkey}` | Required difficulty and remaining quota for one key |
| `POST` | `/events` | Publish one event (§4) |
| `GET` | `/events?page_id=…` | Events for one page, including its threads. Optional `&anchor_id=` narrows to one anchor |
| `GET` | `/events?target_id=…` | Vote events for one target, for independent recount |
| `GET` | `/feed?cursor=…` | The relay's feed (§13) |

Every listing endpoint MUST return results already bounded and diversified: a single
`pubkey` MUST NOT be able to occupy an unbounded portion of one response. Clients apply
their own limits on top (§14); neither side relies on the other.

## 11. Policy document

`GET /policy` returns the relay's machine-readable policy. A client reads it and adapts;
this is the only way one client works against relays with different rules.

```json
{
  "protocol_versions": [1],
  "kinds": ["share", "reply", "vote"],
  "pow": {
    "default_difficulty": { "share": 20, "reply": 18, "vote": 14 },
    "max_difficulty": 24,
    "challenge_required": false
  },
  "freshness_window_seconds": 300,
  "max_payload_bytes": 8192,
  "attestations": {
    "required_for": [],
    "trusted_issuers": ["<hex pubkey>"],
    "feed_requires": ["membership"]
  },
  "quotas": {
    "per_key_per_day": 50,
    "per_key_per_page_per_day": 5,
    "per_key_per_day_by_kind": { "vote": 200 }
  }
}
```

Values are illustrative. A client MUST NOT hardcode any of them, and MUST NOT assume a
field's value when the field is absent.

## 12. Multi-relay clients

A client holds a **set** of relays, editable by the user at any time, each marked readable
and/or writable, with its policy document cached. Single-relay operation is the degenerate
case of a set of one; it is not a separate code path.

**Publishing.** A client mines once at the highest difficulty required by its writable
relays, then submits the same event to each. Per-relay outcomes MUST be surfaced
individually — a relay that rejected while others accepted is not a silent partial
success. If a relay requires its own challenge (§7.2), that event is valid only there and
MUST be mined separately.

**Reading.** A client queries its readable relays and merges. Because `id` is a content
hash, the same event arriving from several relays deduplicates for free. A client SHOULD
record which relays carried an event: presence on many independent relays is a weak
positive signal, and it is what makes relay outages invisible to the reader.

**Disagreement.** Where relays advertise different limits, a client MUST apply the
tightest when constructing an event to broadcast. An `ATTESTATION_REQUIRED` from one relay
is shown to the user, not retried blindly.

**Changing relays MUST NOT affect identity.** The keypair is the identity; a relay is a
place events are kept. Removing every relay and adding new ones loses no identity and
requires no migration.

## 13. Feeds

`GET /feed` is a relay's own curated stream, distinct from the page-scoped queries that
drive the in-page experience.

A feed is an ordinary query plus a filter. The protocol defines no privileged feed and no
privileged relay:

- A relay declares in `policy.attestations.feed_requires` which claims an event must carry
  to appear in its feed.
- A client keeps its own trusted-issuer list and MAY filter further, or ignore the relay's
  filter and build its own view from page queries.

This is how an attestation-gated feed and an open one coexist without either being
special. ElseWeb's own relay gates its feed on a `membership` claim from its
issuer; a different client, pointed at a different relay or configured with a different
trusted-issuer list, produces a different feed from the same protocol.

Feeds are the one surface where the network's page-scoping does **not** bound abuse: a
page query is naturally narrow, a feed is not. Per-`(pubkey, page_id)` quotas do not
constrain a feed. A relay serving a feed MUST therefore apply its own author diversity and
volume bounds, independently of any page-level limit.

## 14. Client rendering obligations

A flood only succeeds if it is displayed. A conforming client:

- MUST NOT render events in raw chronological order;
- MUST cap how many events are rendered per page and per feed screen;
- MUST enforce author diversity, so one `pubkey` cannot dominate a view;
- MUST weight votes by voter standing rather than counting them raw (§5.3);
- SHOULD rank using attestations, key tier and age, engagement, and recency, so that an
  unknown key with no attestation and no engagement sorts to the bottom.

## 15. Key transfer between devices

A user moves one identity between the extension, the website, and the mobile app. The
transfer carries the 32-byte Ed25519 seed inside an encrypted envelope, displayed as a QR
code on the source device and scanned by the target.

```json
{
  "v": 1,
  "type": "key-transfer",
  "kdf": { "name": "PBKDF2-HMAC-SHA256", "salt": "<hex>", "iterations": 600000 },
  "cipher": { "name": "AES-256-GCM", "iv": "<hex>" },
  "ciphertext": "<hex>",
  "expires_at": 0
}
```

- The envelope is decrypted with a **transfer code** shown on the source device and typed
  on the target — never encoded in the QR.
- The transfer code MUST be generated by the client, MUST NOT be chosen by the user, and
  MUST carry at least 60 bits of entropy. A short numeric PIN is not acceptable here: a
  photograph of the QR is enough to attack the envelope offline, at leisure, where an
  expiry timestamp gives no protection at all. Entropy is the only thing defending a
  captured envelope.
- `expires_at` bounds how long a target device will accept the envelope. It defends
  against a stale QR being reused; it does not defend against offline cracking. Expiry is
  exclusive, matching §8.1: `now == expires_at` is expired.
- The QR MUST be displayed only while transfer is in progress, and the source device
  SHOULD warn that anyone who captures both the code and the QR gains the identity
  permanently — a key cannot be rotated without losing its accrued standing.

Transfer works in either direction. Nothing about it involves a relay: a private key MUST
NOT be transmitted to any server, encrypted or not.

## 16. Rejection codes

Every rejection carries a stable code so a client knows what to do. A bare `400` is not
conformant: a client that cannot tell the cases apart will either retry forever or give up
on a recoverable error.

```json
{ "error": { "code": "POW_INSUFFICIENT", "message": "…", "required_difficulty": 22 } }
```

| Code | Extra fields | Client action |
|---|---|---|
| `UNSUPPORTED_VERSION` | `protocol_versions` | Do not retry |
| `UNSUPPORTED_KIND` | `kinds` | Do not retry on this relay |
| `SCHEMA_INVALID` | `field` | Bug. Do not retry |
| `PAYLOAD_TOO_LARGE` | `max_payload_bytes` | Shrink content, re-mine |
| `STALE_TIMESTAMP` | `server_time`, `freshness_window_seconds` | Correct clock skew, re-mine |
| `SIGNATURE_INVALID` | — | Bug. Do not retry |
| `ATTESTATION_INVALID` | `reason` | Refresh the attestation, then retry |
| `ATTESTATION_REQUIRED` | `required_claims`, `trusted_issuers` | Surface to the user. Do not retry |
| `POW_INSUFFICIENT` | `required_difficulty` | Re-mine at the stated difficulty |
| `QUOTA_EXCEEDED` | `retry_after` | Wait. Do not re-mine |

## 17. Proof-of-control challenges

A consumer building an account system on top of the protocol — linking a pubkey to a
Google account, say — MUST NOT trust a bare claim that a pubkey belongs to whoever is
submitting it. A proof-of-control challenge is how the subject key proves it, by
signing a challenge scoped to one consumer and one action. Unlike an attestation, there
is no separate issuer role: control of the key **is** the signature.

```json
{
  "v": 1,
  "type": "proof-of-control",
  "action": "link-account",
  "audience": "<the consumer this challenge is scoped to>",
  "subject": "<hex pubkey proving control of itself>",
  "resource": "<consumer-defined account reference, opaque to the protocol>",
  "nonce": "<16-byte hex, one-time>",
  "issued_at": 0,
  "expires_at": 0,
  "sig": "<subject's own signature over the canonical challenge without sig>"
}
```

- `sig` covers `SHA-256(canonical bytes)` of the challenge without its `sig`, using the
  canonical form of §3, and MUST verify against `subject` — the subject signs its own
  challenge.
- `nonce` MUST be generated by the client, MUST NOT be chosen by a person, and MUST
  carry at least 128 bits of entropy.

**Check order is normative**, same reasoning as §8.1 — the first failure is what a
caller acts on:

1. `type` is one this verifier supports — otherwise `unsupported_type`;
2. `sig` verifies against `subject` — otherwise `signature_invalid`;
3. `audience` equals what the verifier expected — otherwise `audience_mismatch`;
4. `expires_at` is in the future — otherwise `expired`;
5. `action`, `resource` and `subject`, each only when the caller supplies an expected
   value — otherwise `action_mismatch`, `resource_mismatch` or `subject_mismatch`.

**`audience` is what provides domain separation.** A verifier MUST always supply the
`audience` it expects and MUST NOT treat an absent expectation as "any audience is
fine" — a signature made for one consumer MUST NOT verify against a different
consumer's expected audience, even though the signature itself is cryptographically
valid. This is what stops a signed challenge for one consumer being replayed against
another.

**Expiry is exclusive**, matching §8.1: `now == expires_at` is expired. Consumers
SHOULD keep this window short.

**Replay protection is honest about its limits.** The protocol is stateless: it cannot
track "has this nonce been seen before." `nonce` plus a short `expires_at` bound the
*value* of a captured challenge, but only a consumer-side seen-nonce store gives a true
single-use guarantee, exactly as a relay's trusted-issuer list is relay-local state and
not a protocol fact (§8.1). A verifier that needs single-use semantics MUST maintain
that store itself.

## 18. Worker/device delegation

A user's compute may run on several devices — a laptop, a desktop, a server — without
each one holding the user's main identity. A delegation lets one identity
(`owner_pubkey`) authorize another (`worker_pubkey`) to act on its behalf with a
bounded set of `capabilities`, without the owner's private key ever leaving the owner's
device.

```json
{
  "v": 1,
  "type": "worker-delegation",
  "authorization_id": "<16-byte hex>",
  "owner_pubkey": "<hex pubkey of the owner>",
  "worker_pubkey": "<hex pubkey of the worker>",
  "capabilities": ["text.generate"],
  "issued_at": 0,
  "expires_at": 0,
  "sig": "<owner's signature over the canonical delegation without sig>"
}
```

- `capabilities` is an open, namespaced vocabulary — `area.verb` (e.g. `text.generate`,
  `text.embed`, `code.generate`, `image.generate`, `vision.analyze`), never a runtime or
  provider name. New capability names MAY be introduced without a protocol version
  bump, the same way a new attestation `claim` string can be (§8.1).
- **`owner_pubkey` MUST NOT equal `worker_pubkey`.** A key delegating to itself is
  meaningless and MUST be rejected, both when parsing the object and when verifying it,
  so a caller that skips schema validation still fails closed.
- A worker key MUST NOT be able to sign a delegation, a revocation, or anything else
  that grants authority over the owner key. This is structural, not a runtime check: a
  compromised worker key can therefore only be revoked, never used to forge a new
  delegation or impersonate its owner.

**Check order is normative**, and every one of these fails closed — none of them is a
silent pass:

1. `type` is one this verifier supports — otherwise `unsupported_type`;
2. `sig` verifies against `owner_pubkey` — otherwise `signature_invalid`;
3. `owner_pubkey` differs from `worker_pubkey` — otherwise `self_delegation`;
4. `authorization_id` is not in the verifier's known-revoked set — otherwise `revoked`;
5. `expires_at` is in the future — otherwise `expired` (exclusive, matching §8.1);
6. a caller-required capability is present in `capabilities` — otherwise
   `capability_missing`.

Revoked is checked before expired: a revoked-but-not-yet-expired delegation MUST still
fail, not pass on a technicality.

### 18.1 Revocation

```json
{
  "v": 1,
  "type": "worker-revocation",
  "authorization_id": "<the authorization_id being revoked>",
  "owner_pubkey": "<hex pubkey of the owner>",
  "revoked_at": 0,
  "sig": "<owner's signature over the canonical revocation without sig>"
}
```

A revocation is its own small signed object, not a field on the delegation, so an
owner can revoke by `authorization_id` alone, without needing the original delegation
object at hand. `sig` MUST verify against `owner_pubkey`. Whether an `authorization_id`
counts as revoked for the purpose of §18's check 4 is consumer/relay-local state — the
same way a trusted-issuer list is (§8.1) — built from whatever valid revocation objects
that party has seen; the protocol supplies the signed object, not the store.

## 19. Compute receipts

A completed compute job produces a receipt: proof that specific work happened between
a requester and a worker, without carrying the job's prompt or its result. The worker
signs first; the requester MAY countersign afterward, which is what lets a verifier
tell "the worker claims it finished" apart from "the requester confirms it received the
result."

```json
{
  "v": 1,
  "type": "compute-receipt",
  "job_id": "<16-byte hex, ≥128 bits of entropy, chosen by whoever originates the job>",
  "requester_pubkey": "<hex pubkey of the requester>",
  "worker_pubkey": "<hex pubkey of the worker>",
  "capability": "text.generate",
  "usage": { "unit": "tokens", "amount": 512 },
  "result_hash": "<hex SHA-256 of the actual result — never the result itself>",
  "started_at": 0,
  "finished_at": 0,
  "worker_sig": "<worker's signature over the canonical receipt without either sig>",
  "requester_sig": "<optional: requester's signature over the same bytes plus worker_sig>"
}
```

- `job_id` is defined here only as an identifier: a hex value with at least 128 bits of
  entropy, generated by whoever originates the job — a consumer or a router. No job or
  request schema is defined by this document; what a job actually consists of is
  entirely out of scope here.
- `capability` uses the same namespaced vocabulary as §18.
- `usage` is generic metering — a `unit` string and an integer `amount` — never a
  price. What a unit is worth is entirely a consumer's business and MUST NOT appear on
  the wire in this object.
- `result_hash` is a digest of the result, never the result. This object MUST NOT
  carry a prompt or a result in any field.
- **Two-stage signing.** `worker_sig` covers the canonical form of every field except
  both signatures. `requester_sig`, when present, covers the canonical form of every
  field except itself — meaning it includes `worker_sig` — so the countersignature is
  bound to the exact worker-signed receipt, not merely to the fields the two parties
  share.

**Verification**, in order:

1. `type` is one this verifier supports — otherwise `unsupported_type`;
2. `worker_sig` verifies against `worker_pubkey` — otherwise
   `worker_signature_invalid`;
3. if `requester_sig` is present, it verifies against `requester_pubkey` over the
   countersign form (including `worker_sig`) — otherwise `requester_signature_invalid`;
4. if the verifier requires a countersignature and none is present — `not_countersigned`;
5. `finished_at` is not before `started_at` — otherwise `invalid_timespan`.

A verifier reports whether the receipt is countersigned alongside its validity, so a
caller can distinguish "worker claims completion" from "requester confirmed" without a
second check.

## 20. Compute privacy boundary

The compute primitives above are deliberately narrow about what is public.

- **Public, routing-relevant surface**: a delegation's `worker_pubkey` and
  `capabilities` (§18) are what a router needs to find a worker for a job. Nothing more
  is required by this document — not a model name, not a runtime, not a benchmark. Any
  of that MAY be layered on separately by a consumer; the protocol defines no such
  object.
- **Private surface**: a job's prompt and its result never appear in any object this
  document defines. A receipt (§19) carries `result_hash`, never the result. This is a
  structural property of the schema, not a policy enforced at runtime by any party.
- **Honest limitation, stated plainly**: unless a future privacy-preserving execution
  mechanism exists, a worker that runs a job sees its plaintext content. Nothing in
  this document claims otherwise, and no primitive here hides a job from the worker
  performing it — only from the network the job is not otherwise exposed to.

## 21. Generic work-proof for admission control

A router that wants to require computational admission work before accepting an
expensive job — the same anti-abuse property PoW gives events (§7) — needs a proof that
is not itself a social event, so this does not distort the event schema to get PoW's
properties.

```json
{
  "v": 1,
  "type": "work-proof",
  "purpose": "compute-admission",
  "subject": "<hex pubkey whose request this binds to>",
  "resource": "<the specific admission request this proof is for>",
  "created_at": 0,
  "nonce": 0,
  "id": "<hex SHA-256 digest — the mined proof-of-work>"
}
```

- Mining and verification are the **same mechanism as §7**: `id` is
  `SHA-256(canonical bytes)` of this object without `id` (it carries no `sig` field to
  exclude), and difficulty is its leading zero bits. A conforming implementation of §7's
  `mine`/verify machinery works on this object unmodified — no new proof-of-work
  mechanism is introduced by this section.
- **`resource` binds one proof to one specific request.** Without it, a single valid
  proof for a `(purpose, subject)` pair would be replayable across every request that
  `subject` makes inside the freshness window, defeating "repeated abuse gets
  progressively more expensive." A different request needs a freshly mined proof even
  from the same `subject` in the same window.
- `resource` is opaque to the protocol; a router decides what it contains.
- Freshness (§7.2) applies unchanged: `created_at` is inside the hashed bytes, and a
  verifier rejects a proof outside its freshness window in either direction.
- Required difficulty is router-chosen, discovered however that router publishes it —
  this document defines no endpoint for that, the same way §7.3's numbers are relay
  policy rather than protocol constants.
- This mechanism introduces no new relay endpoint and no new rejection code in §16: a
  router requiring work-proof for compute admission is consumer/router-side logic,
  entirely outside the `/events` contract.

---

# Appendix A — threat model and rationale (non-normative)

Recorded here so a later reader does not have to rediscover it.

## A.1 The reframing

Key generation cannot be prevented. Generating an Ed25519 keypair is generating a random
number; if it could be restricted, someone would have to control who may generate one, and
the network would not be federated. So the design does not try:

> Creating a key stays free. Making a key **visible** is what costs.

## A.2 Where page-scoping helps, and where it stops

In-page views are naturally narrow: an attacker cannot flood "the network", only a page,
and the damage is bounded by what that page renders. This is why quotas are enforced per
`(pubkey, page_id)`. It is the cheapest win in the design.

**Feeds remove that protection.** A feed is cross-page by definition, so per-page quotas
do not constrain it and a global stream is exactly the surface page-scoping denied an
attacker. Feeds therefore carry their own bounds, and the attestation gate below exists
mainly because of them.

## A.3 Attestation-gated feeds and what payment actually buys

ElseWeb gates its own feed on a paid membership claim. Payment is the strongest
Sybil resistance available to us: it is costly, hard to automate at volume, and it borrows
the fraud tooling of the payment network.

It is not absolute, and the design does not treat it as such:

- A one-off fee prices a Sybil fleet linearly — a thousand identities is a thousand times
  a small number, which a motivated attacker will pay. A recurring membership changes the
  economics far more than the amount does.
- Stolen payment instruments make the attacker's cost zero. Chargebacks and refunds MUST
  drop membership, which is why attestations expire and are reissued rather than granted
  once (§8.1).
- Accounts are resellable. Payment raises the floor; it does not remove the need for
  quotas, proof-of-work, ranking and diversity underneath it.

The structural point matters more than the amount: because membership is an
**issuer-signed attestation** rather than a private list on our relay, the protocol stays
neutral. Our feed is a filter anyone can express, other issuers can exist, and a community
client can choose a different trusted-issuer list — including none — and get an open feed
from the same network. Had we made the feed a privilege of our own relay, ElseWeb
would be a federated protocol with a centralized product bolted through it.

## A.4 Attacks named, and what answers them

| Attack | Answer |
|---|---|
| Loop that generates keys and posts | Proof-of-work per event (§7) |
| Months of offline pre-mining, released at once | Freshness window binds work to `created_at` (§7.2) |
| Key farm aged in advance to reach a high tier | Turns a five-minute attack into a weeks-long investment; caught by quotas and ranking |
| Flooding one page from many fresh keys | Per-`(pubkey, page_id)` quota, render cap, diversity (§10, §14) |
| Flooding the feed | Attestation gate (§8, §13), plus feed-specific bounds |
| Vote brigading from fresh keys | Votes weighted by standing, never counted raw (§5.3) |
| Relay inventing vote totals | Raw vote events are served for independent recount (§5.3) |
| Hiding the `ephemeral` flag | Nothing depends on the flag; an unflagged new key is already lowest tier (§9) |
| Photographing a transfer QR | Envelope encrypted under a high-entropy client-generated code, never a short PIN (§15) |
| Submitting someone else's pubkey and claiming it as your own | Proof-of-control challenge — the subject must sign, not just be named (§17) |
| Replaying a captured proof-of-control challenge against a different consumer | `audience` is inside the signed bytes and is a required, non-defaultable verify parameter (§17) |
| A compromised worker key used to mint new delegations or impersonate its owner | Delegation is one-directional by construction — a worker key cannot sign anything that grants authority (§18) |
| Reusing one mined work-proof across many compute requests | `resource` binds a proof to one specific request (§21) |

## A.5 Rejected alternatives

- **Feed gated by a private list on our relay.** Same product outcome, but it makes our
  relay structurally privileged and unverifiable by anyone else. Replaced by issuer-signed
  attestations, which are checkable by any third party.
- **Aggregate-only vote counts.** Cheaper and more private, but a relay could fabricate
  totals with no way for anyone to notice. Raw vote events stay available.
- **Invite-gated writes.** Very effective, and abuse is prunable up the invite tree, but it
  closes the network at its edges. Remains available as a relay-level policy.
- **Relay-specific rotating challenge as a requirement.** Fully defeats pre-mining, but
  binds a mined event to one relay and breaks multi-relay broadcast. Left optional.
- **Per-site key rotation.** Better privacy, but reputation restarts everywhere and both
  the tier mechanism and attestations collapse. `ephemeral` mode is the release valve.
- **Non-extractable keys.** Better key hygiene in the browser, and fatal to device
  transfer. Rejected before any key exists, because it cannot be undone afterwards.

## A.6 Media, when it arrives

`content.media` is reserved and absent in v1. It is recorded here because media is the
first thing in this design that does not federate for free, and the shape has to be right
the first time.

An event is broadcast to several relays (§12), but an uploaded file sits on one. If the
event carried a plain URL into the relay it was uploaded to, a reader coming from another
relay sees a broken image, that relay could swap the file silently, and losing one relay
loses the media for everyone.

The shape that survives all three: the event carries the file's **SHA-256** plus a list of
`sources` where it can be fetched. A client tries the sources and verifies what it gets
against the hash, so a substituted file is detected rather than displayed; any relay may
mirror the bytes and add itself as a source; and the media outlives the relay it was first
uploaded to. Content addressing is what makes media as portable as the event carrying it.

## A.7 Three things to be honest about

1. **This does not solve Sybil.** It is economics, not cryptography: raise the cost of an
   attack above its value, and make the flood invisible even when a write succeeds. Any
   design claiming to *prevent* Sybil in a permissionless network is wrong.
2. **Reputation and privacy are in direct conflict.** A persistent key is what lets
   reputation accrue, and it is also what lets a relay link every event to one person. That
   cost was chosen deliberately and must be stated to users, not quietly imposed.
3. **A paid feed splits the network in two.** There is an attested surface and an open one,
   and most users will only ever see the first. Keeping the open one genuinely usable is a
   continuing choice, not something the protocol guarantees on its own.
4. **A stateless protocol cannot itself prevent replay.** A proof-of-control challenge's
   `nonce` and short `expires_at` (§17) bound how long a captured challenge is worth
   anything, but true single-use requires a consumer-side seen-nonce store — the protocol
   supplies the signed object, not the memory of having seen it before. The same is true of
   a compute worker's visibility into plaintext job content (§20): nothing here hides a job
   from the party performing it, and no primitive claims to.
