-- Issue #416: sponsored-submission replay reservations. The primary key is the
-- replay identity (network, credential address, auth nonce) and the concurrency
-- arbiter: a concurrent duplicate INSERT waits on the unique index and then
-- conflicts, so at most one request can reserve a nonce. Rows are purged once
-- the chain passes expiration_ledger (see src/replay.ts). IF NOT EXISTS keeps
-- a re-run on a partially-migrated database harmless.
CREATE TABLE IF NOT EXISTS "submission_replay" (
	"network" text NOT NULL,
	"address" text NOT NULL,
	"nonce" text NOT NULL,
	"expiration_ledger" bigint NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "submission_replay_network_address_nonce_pk" PRIMARY KEY("network","address","nonce")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_replay_expiration_idx" ON "submission_replay" USING btree ("network","expiration_ledger");
