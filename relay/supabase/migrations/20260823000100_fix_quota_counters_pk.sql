-- Postgres primary key columns cannot hold NULL, but page_id is intentionally
-- nullable (NULL = the per-key counter, non-NULL = per-key-per-page). The original
-- primary key in 20260822000200_key_records.sql could therefore never accept the
-- NULL-page_id row that elseweb_record_event inserts for every event, and every
-- POST /events failed in bumpQuota() after the event itself had already been stored.
--
-- Fix: replace the primary key with a surrogate identity column, and enforce the
-- same uniqueness with an expression index that folds NULL page_id to a sentinel
-- ('' cannot occur — page_id is always a 64-char hex string when present). Unlike a
-- primary key, a unique index has no NOT NULL requirement on its underlying columns,
-- and ON CONFLICT can still target it by repeating the same expression.

alter table public.quota_counters drop constraint quota_counters_pkey;

alter table public.quota_counters
  add column id bigint generated always as identity primary key;

create unique index quota_counters_identity_idx
  on public.quota_counters (pubkey, kind, window_start, (coalesce(page_id, '')));

-- Recreate elseweb_record_event with an ON CONFLICT target matching the new index.
-- Body and semantics are unchanged.
create or replace function public.elseweb_record_event(
  p_pubkey text,
  p_page_id text,
  p_kind text,
  p_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := date_trunc('day', p_at);
begin
  insert into public.key_records (pubkey, first_seen, last_event_at)
  values (p_pubkey, p_at, p_at)
  on conflict (pubkey) do update
    set last_event_at = greatest(public.key_records.last_event_at, excluded.last_event_at);

  update public.key_records
     set share_count = share_count + (p_kind = 'share')::int,
         reply_count = reply_count + (p_kind = 'reply')::int,
         vote_count  = vote_count  + (p_kind = 'vote')::int
   where pubkey = p_pubkey;

  -- The per-key counter. A NULL page_id marks it as the unscoped one.
  insert into public.quota_counters (pubkey, page_id, kind, window_start, count)
  values (p_pubkey, null, p_kind, v_window, 1)
  on conflict (pubkey, kind, window_start, (coalesce(page_id, ''))) do update
    set count = public.quota_counters.count + 1;

  -- The per-(key, page) counter. A vote carries no page_id and simply has no such
  -- counter.
  if p_page_id is not null then
    insert into public.quota_counters (pubkey, page_id, kind, window_start, count)
    values (p_pubkey, p_page_id, p_kind, v_window, 1)
    on conflict (pubkey, kind, window_start, (coalesce(page_id, ''))) do update
      set count = public.quota_counters.count + 1;
  end if;
end;
$$;

revoke execute on function public.elseweb_record_event(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.elseweb_record_event(text, text, text, timestamptz) to service_role;
