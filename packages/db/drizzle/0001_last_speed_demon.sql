ALTER TABLE "tokens" ALTER COLUMN "bet_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "granted_by" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_one_origin_ck" CHECK (("tokens"."bet_id" is null) <> ("tokens"."granted_by" is null));