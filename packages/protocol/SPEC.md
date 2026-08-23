# everywhere.app relay protocol — v1 (draft)

Normative specification of the wire contract between a client and a relay.

This document is the source of truth for the federation contract. Anything published on
everywhere.app describing the relay standard is derived from this file, and the two are
updated in the same pull request.

**Implementing the endpoints in §8 is sufficient to run a relay.** Nothing in this
document depends on Supabase, or on our reference implementation in `relay/`.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used in the RFC 2119 sense.

---

## 1. Scope and design principle

The protocol defines **mechanisms, not policy.**

It contains no numeric thresholds — no proof-of-work difficulty, no quota, no tier
definition. Those are each relay's own configuration. What the protocol defines is the
structure that makes a policy expressible, discoverable, and actionable by a client:
the payload fields, the shape of the policy document (§7), and the rejection codes (§6).

A relay MUST be free to be stricter or looser than any other relay without breaking
clients.

## 2. Cryptographic primitives

| Purpose | Algorithm |
|---|---|
| Signature | Ed25519 |
| Hash | SHA-256 |
| Binary encoding | Lowercase hexadecimal |

Ed25519 and SHA-256 are chosen because both are available through WebCrypto in the
extension's runtime, so a conforming client needs no cryptography dependency.

`pubkey` is the 32-byte Ed25519 public key, hex-encoded (64 characters).
`sig` is the 64-byte signature, hex-encoded (128 characters).
`id` is the 32-byte SHA-256 digest, hex-encoded (64 characters).

## 3. Canonical serialization

Signatures and proof-of-work are computed over the same byte sequence. If two
implementations serialize the same payload differently, signatures fail to verify and
the cause is very hard to find. Canonicalization is therefore normative.

- The canonical form is **JSON Canonicalization Scheme, RFC 8785** (JCS): object keys
  sorted by UTF-16 code unit, no insignificant whitespace, UTF-8 output.
- The canonical form covers every field of the share object **except `id` and `sig`**,
  which are omitted entirely (not set to `null`).
- Optional fields that are absent MUST be omitted, never serialized as `null`. A field
  present with a `null` value and a field absent are different canonical forms and
  therefore different payloads.
- **All numbers MUST be integers.** No floating point values appear anywhere in a
  payload, which removes RFC 8785's number-formatting edge cases entirely.
- Canonicalization MUST NOT alter string content. Clients SHOULD apply Unicode NFC
  normalization to human-entered text *before* constructing the payload, so that the same
  visible text produces the same bytes.

Then:

```
canonical_bytes = JCS(share without id and sig)
id              = hex(SHA-256(canonical_bytes))
sig             = hex(Ed25519-Sign(privkey, SHA-256(canonical_bytes)))
```

Implementations MUST ship test vectors: hand-written payloads with their expected
canonical bytes, `id`, and `sig`. Anyone writing a second relay validates against these.

## 4. The share object

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | integer | yes | Protocol version. `1` for this document |
| `pubkey` | hex string | yes | Author's Ed25519 public key |
| `page_id` | hex string | yes | Normalized page identity (§5) |
| `created_at` | integer | yes | Unix seconds. Binds freshness (§6.2) |
| `identity_mode` | `"persistent"` \| `"ephemeral"` | yes | See §9 |
| `content` | object | yes | The shared content. Shape defined by the schemas in this package |
| `nonce` | integer | yes | Varied during mining (§6.1) |
| `attestations` | array | yes | Reserved. MUST be `[]` in v1. See §10 |
| `id` | hex string | yes | Per §3. Not part of the canonical form |
| `sig` | hex string | yes | Per §3. Not part of the canonical form |

A relay MUST verify, in this order, and MUST reject on the first failure:

1. `v` is a protocol version the relay speaks — otherwise `UNSUPPORTED_VERSION`;
2. the object matches the schema — otherwise `SCHEMA_INVALID`;
3. the encoded size is within the relay's limit — otherwise `PAYLOAD_TOO_LARGE`;
4. `created_at` is inside the freshness window — otherwise `STALE_TIMESTAMP`;
5. `id` equals the hash of the recomputed canonical bytes — otherwise `SCHEMA_INVALID`;
6. `sig` verifies against `pubkey` — otherwise `SIGNATURE_INVALID`;
7. `id` carries sufficient work — otherwise `POW_INSUFFICIENT`;
8. the author is within quota — otherwise `QUOTA_EXCEEDED`.

Version is checked first so that a relay never rejects a payload it simply does not
understand with a code that tells the client its payload was malformed.

Signature and proof-of-work are checked before any quota lookup, so an unauthenticated
caller cannot cause database work.

## 5. Page identity

`page_id` is an opaque hex string derived from the page's URL by this package's
normalization function. Two users on the same page MUST derive the same `page_id`, or
they cannot see each other — this is the product's core correctness requirement.

The derivation rules are specified separately in this package and are **part of the
protocol**. Changing them changes which users can see each other, which partitions the
network. A change to normalization is therefore a breaking protocol change and requires
a version bump.

A relay MUST treat `page_id` as opaque. It MUST NOT re-derive, rewrite, or interpret it.

## 6. Proof of work

### 6.1 Definition

Difficulty is the number of leading zero **bits** of the `id` digest. A client mines by
varying `nonce` and recomputing `id` until the required difficulty is met.

Verification is stateless: counting leading zero bits of a value the relay already
computed in step 4. A relay can verify work from an author it has never seen, which is
what makes this mechanism usable across a federation.

Proof-of-work is acceptable here because sharing is a rare, deliberate, user-initiated
action. It MUST NOT be required on read paths.

### 6.2 Freshness — why the window exists

Without a freshness constraint, proof-of-work accomplishes nothing: an attacker mines
payloads offline for months and releases them all at once. The stockpile *is* the flood.

Because `created_at` is inside the canonical bytes, it is committed to by `id` and
therefore by the work. A relay MUST reject a share whose `created_at` lies outside its
advertised freshness window, in either direction. Pre-computed work is then worth at most
one window.

Clients SHOULD mine immediately before submitting. Clients MUST NOT retain a mined
payload beyond the window and resubmit it.

A relay MAY additionally require its own rotating challenge value. This is optional by
design: a relay-specific challenge makes one mined payload valid at one relay only, which
works against publishing the same share to several relays.

### 6.3 Adaptive difficulty

The required difficulty MAY vary per author — high for an unknown key, low or zero for an
established one. Discovery works as follows:

- `GET /policy` (§7) advertises the difficulty required of an **unknown** key.
- `GET /keys/{pubkey}` (§8) returns the difficulty currently required of that key.
- A `POW_INSUFFICIENT` rejection carries `required_difficulty`, so a client that guessed
  low recovers in a single retry.

Clients SHOULD cache their own requirement and re-check it periodically.

### 6.4 Client obligations

Mining MUST be cancellable and MUST report progress to the user. A client MUST stop at a
bounded effort and surface a clear error rather than appearing to hang.

## 7. Policy document

`GET /policy` returns the relay's machine-readable policy. A client reads it and adapts;
this is the only way one extension works against relays with different rules.

```json
{
  "protocol_versions": [1],
  "pow": {
    "default_difficulty": 20,
    "max_difficulty": 24,
    "challenge_required": false
  },
  "freshness_window_seconds": 300,
  "max_payload_bytes": 8192,
  "attestation_required": false,
  "quotas": {
    "per_key_per_day": 50,
    "per_key_per_page_per_day": 5
  }
}
```

The values above are illustrative. A client MUST NOT hardcode any of them, and MUST NOT
assume a field's value when the field is absent.

## 8. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/policy` | Policy document (§7) |
| `GET` | `/keys/{pubkey}` | Required difficulty and remaining quota for one key |
| `POST` | `/shares` | Publish a share object (§4) |
| `GET` | `/shares?page_id=…` | Shares for one page |

`GET /shares` MUST return results already bounded and diversified — a single `pubkey`
MUST NOT be able to occupy an unbounded portion of one page's response. Clients apply
their own limits on top (§11); neither side relies on the other.

## 9. Identity modes

- **`persistent`** — the default. Reputation accrues to this key; key age and quota tiers
  are built on it.
- **`ephemeral`** — a single-use key. Relays SHOULD apply their lowest quota and clients
  SHOULD rank it lowest.

**A relay cannot distinguish an `ephemeral` key from a newly created persistent one.**
The field is an honest client's declaration, not a security control. An attacker who
omits it is simply treated as a new key, which is already the lowest tier. No security
property may depend on this field.

Users MUST be told that a persistent key lets a relay link all of their shares together.

## 10. Attestations — reserved in v1

`attestations` MUST be `[]` in v1. The field exists now so that adding it later is not a
breaking change.

The intended v2 shape is a list of publicly verifiable claims:

```json
{ "type": "x.com", "value": "<handle>", "proof_url": "<url>" }
```

An attestation is verified by fetching `proof_url` and finding the key's fingerprint
there — in a profile bio or a public post. Anyone can verify it independently; no central
authority is involved. The effect is that a Sybil identity costs whatever an account on
the host platform costs, which outsources Sybil resistance to a platform already spending
heavily on it.

`ATTESTATION_REQUIRED` (§12) is reserved for relays that will require this.

## 11. Client rendering obligations

A flood only succeeds if it is displayed. A conforming client:

- MUST NOT render shares in raw chronological order;
- MUST cap the number of shares rendered per page;
- MUST enforce author diversity, so one `pubkey` cannot dominate a page's view;
- SHOULD rank using key tier and age, engagement, and recency, so that an unknown key
  with no engagement sorts to the bottom.

## 12. Rejection codes

Every rejection carries a stable code so a client knows what to do. A bare `400` is not
conformant: a client that cannot tell the cases apart will either retry forever or give
up on a recoverable error.

```json
{ "error": { "code": "POW_INSUFFICIENT", "message": "…", "required_difficulty": 22 } }
```

| Code | Extra fields | Client action |
|---|---|---|
| `SCHEMA_INVALID` | `field` | Bug. Do not retry |
| `PAYLOAD_TOO_LARGE` | `max_payload_bytes` | Shrink content, re-mine |
| `STALE_TIMESTAMP` | `server_time`, `freshness_window_seconds` | Correct clock skew, re-mine |
| `SIGNATURE_INVALID` | — | Bug. Do not retry |
| `POW_INSUFFICIENT` | `required_difficulty` | Re-mine at the stated difficulty |
| `QUOTA_EXCEEDED` | `retry_after` | Wait. Do not re-mine |
| `ATTESTATION_REQUIRED` | `accepted_types` | Reserved for v2 |
| `UNSUPPORTED_VERSION` | `protocol_versions` | Do not retry |

---

# Appendix A — threat model and rationale (non-normative)

Recorded here so that a later reader does not have to rediscover it.

## A.1 The reframing

Key generation cannot be prevented. Generating an Ed25519 keypair is generating a random
number; if it could be restricted, someone would have to control who may generate one,
and the network would not be federated. So the design does not try:

> Creating a key stays free. Making a key **visible** is what costs.

## A.2 Structural advantage: content is page-scoped

Shares are only visible on the page they were made on. An attacker cannot flood "the
network", only a page, and the damage is bounded by what that page renders. This is why
quotas are enforced per `(pubkey, page_id)` and not only per `pubkey`. It is the cheapest
win in the design.

## A.3 Attacks named, and what answers them

| Attack | Answer |
|---|---|
| Loop that generates keys and posts | Proof-of-work per share (§6) |
| Months of offline pre-mining, released at once | Freshness window binds work to `created_at` (§6.2) |
| Key farm aged in advance to reach a high tier | Turns a five-minute attack into a weeks-long investment; caught by quotas and ranking |
| Flooding one page from many fresh keys | Per-`(pubkey, page_id)` quota, render cap, diversity requirement (§8, §11) |
| Hiding the `ephemeral` flag | Nothing depends on the flag; an unflagged new key is already lowest tier (§9) |

## A.4 Rejected alternatives

- **Invite-gated writes.** Very effective against Sybil, and abuse is prunable up the
  invite tree — but it closes the network at its edges and contradicts permissionless
  federation. Rejected for the MVP; remains available as a relay-level policy.
- **Relay-specific rotating challenge as a requirement.** Fully defeats pre-mining, but
  binds a mined payload to one relay and penalizes multi-relay publishing. Left optional.
- **Per-site key rotation.** Better privacy, but reputation restarts everywhere and the
  age/quota mechanism collapses. Rejected; `ephemeral` mode is the release valve.
- **Attestation required from day one.** Strongest defense available, but real UX friction
  and a hard dependency on the host platform. Deferred, with the field reserved.

## A.5 Two things to be honest about

1. **This does not solve Sybil.** It is economics, not cryptography: raise the cost of an
   attack above its value, and make the flood invisible even when the write succeeds. Any
   design claiming to *prevent* Sybil in a permissionless network is wrong.
2. **Reputation and privacy are in direct conflict.** A persistent key is what lets
   reputation accrue, and it is also what lets a relay link every share to one person.
   That cost is real, was chosen deliberately, and must be stated to users rather than
   quietly imposed.
