CREATE TYPE "public"."bet_status" AS ENUM('proposed', 'active', 'claim_pending', 'disputed', 'resolved', 'void', 'declined', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."claim_kind" AS ENUM('win', 'lose', 'void');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('open', 'confirmed', 'disputed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."mute_kind" AS ENUM('timeout', 'honor');--> statement-breakpoint
CREATE TYPE "public"."mute_status" AS ENUM('active', 'paused', 'completed');--> statement-breakpoint
CREATE TYPE "public"."rejoin_policy" AS ENUM('restart_full', 'resume_remaining');--> statement-breakpoint
CREATE TYPE "public"."token_expiry" AS ENUM('7d', '30d', '90d', '365d', 'never');--> statement-breakpoint
CREATE TYPE "public"."token_status" AS ENUM('available', 'queued', 'active', 'completed', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."unmutable_policy" AS ENUM('honor', 'reject');--> statement-breakpoint
CREATE TABLE "bet_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"claimant_id" text NOT NULL,
	"kind" "claim_kind" NOT NULL,
	"status" "claim_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"respond_by" timestamp with time zone NOT NULL,
	"responder_id" text,
	"responded_at" timestamp with time zone,
	"reason" text,
	"dm_channel_id" text,
	"dm_message_id" text
);
--> statement-breakpoint
CREATE TABLE "bets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"challenger_id" text NOT NULL,
	"opponent_id" text NOT NULL,
	"terms" text NOT NULL,
	"duration_s" integer NOT NULL,
	"status" "bet_status" DEFAULT 'proposed' NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"challenger_accepted_at" timestamp with time zone,
	"opponent_accepted_at" timestamp with time zone,
	"accept_by" timestamp with time zone NOT NULL,
	"winner_id" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"actor_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" text PRIMARY KEY NOT NULL,
	"marker_role_id" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"max_concurrent_mutes" integer DEFAULT 3 NOT NULL,
	"token_expiry" "token_expiry" DEFAULT '30d' NOT NULL,
	"allowed_durations" text[] DEFAULT '{30m,1h,2h,6h,24h}'::text[] NOT NULL,
	"confirm_window_s" integer DEFAULT 259200 NOT NULL,
	"target_cooldown_s" integer DEFAULT 86400 NOT NULL,
	"max_open_proposals_per_user" integer DEFAULT 3 NOT NULL,
	"unmutable_members" "unmutable_policy" DEFAULT 'honor' NOT NULL,
	"rejoin_policy" "rejoin_policy" DEFAULT 'restart_full' NOT NULL,
	"admin_role_id" text,
	"announce_channel_id" text,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"token_id" uuid NOT NULL,
	"target_id" text NOT NULL,
	"kind" "mute_kind" NOT NULL,
	"status" "mute_status" DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"remaining_s" integer,
	"timeout_set_to" timestamp with time zone,
	"last_callout_at" timestamp with time zone,
	"lifted_by" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"bet_id" uuid NOT NULL,
	"holder_id" text NOT NULL,
	"target_id" text NOT NULL,
	"duration_s" integer NOT NULL,
	"status" "token_status" DEFAULT 'available' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"queued_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bet_claims" ADD CONSTRAINT "bet_claims_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutes" ADD CONSTRAINT "mutes_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bet_claims_one_open_uq" ON "bet_claims" USING btree ("bet_id") WHERE "bet_claims"."status" = 'open';--> statement-breakpoint
CREATE INDEX "bet_claims_open_respond_by_idx" ON "bet_claims" USING btree ("respond_by") WHERE "bet_claims"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "bets_guild_short_id_uq" ON "bets" USING btree ("guild_id","short_id");--> statement-breakpoint
CREATE INDEX "bets_proposed_by_challenger_idx" ON "bets" USING btree ("guild_id","challenger_id") WHERE "bets"."status" = 'proposed';--> statement-breakpoint
CREATE INDEX "bets_message_idx" ON "bets" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "bets_guild_status_idx" ON "bets" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "events_entity_idx" ON "events" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "mutes_token_uq" ON "mutes" USING btree ("token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mutes_one_running_per_target_uq" ON "mutes" USING btree ("guild_id","target_id") WHERE "mutes"."status" in ('active', 'paused');--> statement-breakpoint
CREATE INDEX "mutes_target_ended_idx" ON "mutes" USING btree ("guild_id","target_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_guild_short_id_uq" ON "tokens" USING btree ("guild_id","short_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_bet_uq" ON "tokens" USING btree ("bet_id");--> statement-breakpoint
CREATE INDEX "tokens_holder_idx" ON "tokens" USING btree ("guild_id","holder_id","status");--> statement-breakpoint
CREATE INDEX "tokens_queue_idx" ON "tokens" USING btree ("guild_id","queued_at") WHERE "tokens"."status" = 'queued';