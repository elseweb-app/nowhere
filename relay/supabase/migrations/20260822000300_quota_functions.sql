-- Quota accounting as two functions rather than as queries in the edge function.
--
-- Recording an event touches three counters and a key record; doing that as four
-- statements from the function would leave a window where an event is stored but not
-- counted, which is exactly the window a flood would find. One round trip, one
-- transaction, no window.

-- Counts an accepted event against its author's budget and creates the key record the
-- first time a pubkey is seen. Called only after verification has already passed.
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

  -- The per-key counter. A NULL page_id marks it as the unscoped one; the primary key
  -- treats NULLs as distinct, so this row is inserted explicitly rather than relying on
  -- ON CONFLICT to find it.
  insert into public.quota_counters (pubkey, page_id, kind, window_start, count)
  values (p_pubkey, null, p_kind, v_window, 1)
  on conflict (pubkey, page_id, kind, window_start) do update
    set count = public.quota_counters.count + 1;

  -- The per-(key, page) counter, which relay/AGENTS.md names as the bound that actually
  -- stops a flood: content is page-scoped, so a per-page cap is what limits one, and it
  -- is nearly free to apply. A vote carries no page_id and simply has no such counter.
  if p_page_id is not null then
    insert into public.quota_counters (pubkey, page_id, kind, window_start, count)
    values (p_pubkey, p_page_id, p_kind, v_window, 1)
    on conflict (pubkey, page_id, kind, window_start) do update
      set count = public.quota_counters.count + 1;
  end if;
end;
$$;

-- The three counts the relay's quota check needs, in one query. A NULL p_page_id or
-- p_kind means the caller has none in scope (GET /keys/{pubkey} asks this way), and the
-- corresponding count comes back 0 — matching the port contract in relay/src/store.js.
create or replace function public.elseweb_quota_usage(
  p_pubkey text,
  p_page_id text,
  p_kind text,
  p_since timestamptz
) returns table (per_key bigint, per_key_per_page bigint, per_key_per_kind bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(count) filter (where page_id is null), 0)::bigint,
    coalesce(sum(count) filter (where p_page_id is not null and page_id = p_page_id), 0)::bigint,
    coalesce(sum(count) filter (where p_kind is not null and kind = p_kind and page_id is null), 0)::bigint
  from public.quota_counters
  where pubkey = p_pubkey
    and window_start >= date_trunc('day', p_since);
$$;

-- Both are SECURITY DEFINER so they can read and write tables that have RLS enabled and
-- no policies. EXECUTE is therefore revoked from everyone except the service_role the
-- edge function runs as — a SECURITY DEFINER function callable by anon would be a hole
-- straight through the RLS the tables were given.
revoke execute on function public.elseweb_record_event(text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.elseweb_quota_usage(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.elseweb_record_event(text, text, text, timestamptz) to service_role;
grant execute on function public.elseweb_quota_usage(text, text, text, timestamptz) to service_role;
