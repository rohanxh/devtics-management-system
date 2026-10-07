CREATE TYPE "public"."backlink_status" AS ENUM('prospect', 'outreach', 'live', 'lost', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."campaign_channel" AS ENUM('seo', 'ppc', 'social', 'email', 'content', 'event', 'referral', 'partnership', 'other');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('planned', 'active', 'paused', 'completed');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('blog_post', 'landing_page', 'case_study', 'social_post', 'newsletter', 'video', 'other');--> statement-breakpoint
CREATE TYPE "public"."data_source" AS ENUM('manual', 'ga4', 'search_console', 'import');--> statement-breakpoint
CREATE TYPE "public"."search_intent" AS ENUM('informational', 'commercial', 'transactional', 'navigational');--> statement-breakpoint
CREATE TYPE "public"."traffic_channel" AS ENUM('organic', 'paid', 'social', 'referral', 'direct', 'email', 'other');--> statement-breakpoint
CREATE TABLE "backlinks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site" text NOT NULL,
	"source_url" text NOT NULL,
	"target_url" text,
	"anchor_text" text,
	"domain_authority" integer,
	"status" "backlink_status" DEFAULT 'prospect' NOT NULL,
	"acquired_on" date,
	"lost_on" date,
	"cost" numeric(14, 2),
	"owner_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"channel" "campaign_channel" DEFAULT 'content' NOT NULL,
	"status" "campaign_status" DEFAULT 'planned' NOT NULL,
	"start_date" date,
	"end_date" date,
	"budget" numeric(14, 2),
	"spend" numeric(14, 2) DEFAULT '0' NOT NULL,
	"utm_campaign" text,
	"goal" text,
	"owner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"type" "content_type" DEFAULT 'blog_post' NOT NULL,
	"stage_id" uuid NOT NULL,
	"assignee_id" uuid,
	"keyword_id" uuid,
	"campaign_id" uuid,
	"due_date" date,
	"brief" text,
	"word_count" integer,
	"published_url" text,
	"published_on" date,
	"sessions" integer,
	"conversions" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyword_rankings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyword_id" uuid NOT NULL,
	"checked_on" date NOT NULL,
	"position" integer,
	"url" text,
	"source" "data_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site" text NOT NULL,
	"project_id" uuid,
	"audit_date" date NOT NULL,
	"tool" text,
	"health_score" integer,
	"issues_critical" integer DEFAULT 0 NOT NULL,
	"issues_warning" integer DEFAULT 0 NOT NULL,
	"pages_crawled" integer,
	"summary" text,
	"auditor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyword" text NOT NULL,
	"site" text NOT NULL,
	"project_id" uuid,
	"company_id" uuid,
	"target_url" text,
	"search_volume" integer,
	"difficulty" integer,
	"intent" "search_intent",
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"current_position" integer,
	"previous_position" integer,
	"best_position" integer,
	"last_checked_on" date,
	"owner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traffic_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"channel" "traffic_channel" NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"users" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"source" "data_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backlinks" ADD CONSTRAINT "backlinks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_keyword_id_seo_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."seo_keywords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_rankings" ADD CONSTRAINT "keyword_rankings_keyword_id_seo_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."seo_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_audits" ADD CONSTRAINT "seo_audits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_audits" ADD CONSTRAINT "seo_audits_auditor_id_users_id_fk" FOREIGN KEY ("auditor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_keywords" ADD CONSTRAINT "seo_keywords_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_keywords" ADD CONSTRAINT "seo_keywords_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_keywords" ADD CONSTRAINT "seo_keywords_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_stage_idx" ON "content_items" USING btree ("stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rankings_uq" ON "keyword_rankings" USING btree ("keyword_id","checked_on");--> statement-breakpoint
CREATE UNIQUE INDEX "keywords_uq" ON "seo_keywords" USING btree ("site","keyword");--> statement-breakpoint
CREATE UNIQUE INDEX "traffic_uq" ON "traffic_snapshots" USING btree ("site","period_start","channel");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;