-- The event table mirrors the protocol envelope (SPEC.md section 4) closely enough that
-- mapping stays trivial, per relay/AGENTS.md. Fields a kind does not use stay NULL; the
-- protocol's rule that an unused field is absent rather than empty is enforced in the
-- verification pipeline, not here, because a relay must never rewrite what it stores.

create table if not exists public.events (
  -- The content hash from SPEC.md section 3. It is the primary key because it already
  -- deduplicates: the same event arriving from two places is the same row, with no
  -- coordination needed.
  id text primary key check (id ~ '^[0-9a-f]{64}$'),

  v integer not null,
  kind text not null check (kind in ('share', 'reply', 'vote')),
  pubkey text not null check (pubkey ~ '^[0-9a-f]{64}$'),
  created_at bigint not null,
  identity_mode text not null check (identity_mode in ('persistent', 'ephemeral')),
  nonce bigint not null,
  attestations jsonb not null default '[]'::jsonb,

  -- Opaque to this relay. SPEC.md section 6.3 forbids re-deriving or rewriting it: doing
  -- so would couple every relay to one normalization version and reject any client
  -- running a different one.
  page_id text check (page_id ~ '^[0-9a-f]{64}$'),
  page_url text,
  anchor_id text,

  parent_id text check (parent_id ~ '^[0-9a-f]{64}$'),
  root_id text check (root_id ~ '^[0-9a-f]{64}$'),
  target_id text check (target_id ~ '^[0-9a-f]{64}$'),

  content jsonb not null,
  sig text not null check (sig ~ '^[0-9a-f]{128}$'),

  -- Arrival time, distinct from the author-claimed created_at. Feed cursors page on this
  -- so a lying created_at cannot reorder someone else's feed.
  received_at timestamptz not null default now()
);

-- The page query (SPEC.md section 10) is the read that drives the in-page experience, so
-- it gets the index that makes it one lookup: a share and its whole thread share page_id.
create index if not exists events_page_idx
  on public.events (page_id, received_at desc)
  where page_id is not null;

create index if not exists events_anchor_idx
  on public.events (page_id, anchor_id, received_at desc)
  where anchor_id is not null;

-- Vote recount (SPEC.md section 5.3): a client must be able to fetch the raw votes for a
-- target and reach the same tally the relay reports.
create index if not exists events_target_idx
  on public.events (target_id, created_at desc)
  where target_id is not null;

create index if not exists events_thread_idx
  on public.events (root_id)
  where root_id is not null;

-- Quota enforcement counts an author's recent events, per key and per (key, page).
create index if not exists events_author_idx on public.events (pubkey, received_at desc);
create index if not exists events_author_page_idx on public.events (pubkey, page_id, received_at desc);
create index if not exists events_feed_idx on public.events (received_at desc);

alter table public.events enable row level security;

-- Reads are public: the network's whole point is that anyone running any client can read
-- it. Writes are not — every write goes through the edge function, which is the only
-- place the eleven-step verification in SPEC.md section 4 happens. An anon client that
-- could INSERT directly would bypass signature, proof-of-work and quota checks entirely.
create policy events_public_read on public.events
  for select
  using (true);

-- No insert/update/delete policy is written on purpose. With RLS enabled and no policy,
-- those verbs are denied to anon and authenticated roles; the service_role key used
-- inside the edge function bypasses RLS. Events are immutable once accepted: there is no
-- update path because the id is a content hash, so an edited event is a different event.
