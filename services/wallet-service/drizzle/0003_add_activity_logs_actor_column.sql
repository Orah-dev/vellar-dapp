-- Issue #256: activity_logs.actor was only ever readable via the data JSONB
-- blob (data.actor), which made a per-wallet transaction history query a
-- full-table scan filtered in application code. Add it as a real, indexed
-- column so GET /wallets/:id/transactions can use an indexed keyset query.
--
-- Backfill from the existing data.actor JSONB for any pre-existing rows, so
-- history for transactions submitted before this migration is not silently
-- lost. New inserts write the actor column directly (see
-- createPgAuditLog.record in src/db/pg-repository.ts) and no longer need the
-- JSONB copy, but data.actor is left in place rather than stripped: existing
-- consumers of AuditLog.list() (unpaginated, JSON-body driven) still read it,
-- and removing it would be an unrelated, riskier cleanup for this issue to
-- take on.
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "actor" text;
--> statement-breakpoint
UPDATE "activity_logs"
  SET "actor" = "data"->>'actor'
  WHERE "actor" IS NULL AND "data"->>'actor' IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_logs_actor_at_id_idx" ON "activity_logs" USING btree ("actor","at","id");
