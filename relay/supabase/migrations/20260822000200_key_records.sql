-- Anti-flood state, per relay/AGENTS.md: "Keys are free to create, so identity alone
-- carries no weight." A key earns a lower difficulty and a larger quota by getting older
-- with a clean record. The numbers that turn this row into a tier are configuration read
-- by the edge function, never literals here or in code.

create table if not exists public.key_records (
  pubkey text primary key check (pubkey ~ '^[0-9a-f]{64}$'),
  first_seen timestamptz not null default now(),
  last_event_at timestamptz,
  share_count bigint not null default 0,
  reply_count bigint not null default 0,
  vote_count bigint not null default 0,
  report_count bigint not null default 0
);

alter table public.key_records enable row level security;

-- GET /keys/{pubkey} (SPEC.md section 10) answers out of this table, but it answers
-- through the edge function, which returns the protocol's shape — a required difficulty
-- and a remaining quota — rather than these columns. relay/AGENTS.md: responses are the
-- protocol's shapes and nothing more, no leaking database column names.
--
-- So there is deliberately no read policy either. A key's report count and first-seen
-- time are this relay's own bookkeeping, and publishing them raw would hand an attacker
-- a way to watch their own tier and tune a flood against it.

-- Quota counters are kept separately from key_records so that expiring a window is a
-- delete of old rows rather than a rewrite of the key's whole history.
create table if not exists public.quota_counters (
  pubkey text not null check (pubkey ~ '^[0-9a-f]{64}$'),
  -- NULL page_id is the per-key counter; a non-NULL one is the per-(key, page) counter
  -- that relay/AGENTS.md calls out as the bound that actually stops a flood, since
  -- content is page-scoped and the check is nearly free.
  page_id text,
  kind text not null check (kind in ('share', 'reply', 'vote')),
  window_start timestamptz not null,
  count bigint not null default 0,
  primary key (pubkey, page_id, kind, window_start)
);

create index if not exists quota_counters_window_idx on public.quota_counters (window_start);

alter table public.quota_counters enable row level security;

-- No policies: quota state is enforcement machinery. Only the edge function's
-- service_role touches it, and exposing a caller's remaining budget belongs to
-- GET /keys/{pubkey} in the protocol's own shape, not to a raw table read.
