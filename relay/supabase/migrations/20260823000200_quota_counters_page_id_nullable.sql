-- Follow-up to 20260823000100_fix_quota_counters_pk.sql, which dropped the
-- (pubkey, page_id, kind, window_start) primary key but missed a Postgres detail:
-- a primary key implicitly marks every one of its columns NOT NULL at the moment the
-- constraint is created, and dropping the constraint does not reverse that. page_id
-- was left NOT NULL, so elseweb_record_event's NULL-page_id insert for the per-key
-- counter still failed and POST /events still 500'd after that migration.
--
-- 20260823000100 is already applied and is not edited here per relay/AGENTS.md
-- ("never edit a migration that has already been applied").

alter table public.quota_counters alter column page_id drop not null;
