CREATE TYPE "public"."kb_category" AS ENUM('sop', 'policy', 'dev_standard', 'qa_standard', 'pm_procedure', 'sales_procedure', 'hr_policy', 'template', 'training', 'architecture', 'other');--> statement-breakpoint
CREATE TYPE "public"."kb_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "kb_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_audiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"role_id" uuid,
	"department_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"change_summary" text,
	"created_by_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"category" "kb_category" DEFAULT 'sop' NOT NULL,
	"summary" text,
	"owner_id" uuid,
	"status" "kb_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"required_reading" boolean DEFAULT false NOT NULL,
	"acknowledge_within_days" integer DEFAULT 7 NOT NULL,
	"review_interval_days" integer,
	"last_reviewed_on" date,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_articles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "kb_reading_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_acknowledgements" ADD CONSTRAINT "kb_acknowledgements_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_acknowledgements" ADD CONSTRAINT "kb_acknowledgements_version_id_kb_article_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."kb_article_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_acknowledgements" ADD CONSTRAINT "kb_acknowledgements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_audiences" ADD CONSTRAINT "kb_article_audiences_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_audiences" ADD CONSTRAINT "kb_article_audiences_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_audiences" ADD CONSTRAINT "kb_article_audiences_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_published_by_id_users_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_current_version_id_kb_article_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."kb_article_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_reading_assignments" ADD CONSTRAINT "kb_reading_assignments_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_reading_assignments" ADD CONSTRAINT "kb_reading_assignments_version_id_kb_article_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."kb_article_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_reading_assignments" ADD CONSTRAINT "kb_reading_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_ack_uq" ON "kb_acknowledgements" USING btree ("version_id","user_id");--> statement-breakpoint
CREATE INDEX "kb_audience_article_idx" ON "kb_article_audiences" USING btree ("article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_versions_uq" ON "kb_article_versions" USING btree ("article_id","version_number");--> statement-breakpoint
CREATE INDEX "kb_category_idx" ON "kb_articles" USING btree ("category","status");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_assign_uq" ON "kb_reading_assignments" USING btree ("version_id","user_id");--> statement-breakpoint
CREATE INDEX "kb_assign_user_idx" ON "kb_reading_assignments" USING btree ("user_id");