CREATE TABLE "verification_records_archive" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL,
	"archived_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vr_archive_contract_idx" ON "verification_records_archive" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "vr_archive_status_idx" ON "verification_records_archive" USING btree ("status");--> statement-breakpoint
CREATE INDEX "vr_archive_archived_at_idx" ON "verification_records_archive" USING btree ("archived_at");