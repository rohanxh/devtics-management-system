CREATE TYPE "public"."bug_status" AS ENUM('new', 'confirmed', 'in_progress', 'fixed', 'ready_for_retest', 'verified', 'reopened', 'closed', 'wont_fix', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."tech_debt_status" AS ENUM('open', 'planned', 'in_progress', 'resolved', 'wont_fix');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('pending_approval', 'approved', 'rejected', 'in_progress', 'succeeded', 'failed', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."effort" AS ENUM('small', 'medium', 'large');--> statement-breakpoint
CREATE TYPE "public"."environment_kind" AS ENUM('development', 'staging', 'production');--> statement-breakpoint
CREATE TYPE "public"."environment_status" AS ENUM('healthy', 'degraded', 'down', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."found_in" AS ENUM('qa', 'client', 'production', 'internal');--> statement-breakpoint
CREATE TYPE "public"."git_provider" AS ENUM('github', 'gitlab', 'bitbucket', 'other');--> statement-breakpoint
CREATE TYPE "public"."pull_request_status" AS ENUM('open', 'changes_requested', 'approved', 'merged', 'closed');--> statement-breakpoint
CREATE TYPE "public"."qa_category" AS ENUM('wordpress', 'elementor', 'woocommerce', 'mobile_app', 'seo', 'performance', 'security', 'pre_launch', 'general');--> statement-breakpoint
CREATE TYPE "public"."qa_run_status" AS ENUM('planned', 'in_progress', 'completed', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."test_result_status" AS ENUM('pending', 'pass', 'fail', 'blocked', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."tech_review_kind" AS ENUM('feasibility', 'architecture', 'integration', 'infrastructure', 'security', 'other');--> statement-breakpoint
CREATE TYPE "public"."tech_review_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."technology_category" AS ENUM('language', 'framework', 'cms', 'database', 'hosting', 'service', 'tool');--> statement-breakpoint
CREATE TABLE "bugs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"steps_to_reproduce" text,
	"expected_result" text,
	"actual_result" text,
	"severity" "severity" DEFAULT 'medium' NOT NULL,
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"status" "bug_status" DEFAULT 'new' NOT NULL,
	"environment" "environment_kind",
	"found_in" "found_in" DEFAULT 'qa' NOT NULL,
	"reported_by_id" uuid,
	"assignee_id" uuid,
	"introduced_by_id" uuid,
	"qa_run_id" uuid,
	"test_case_id" uuid,
	"ticket_id" uuid,
	"retest_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bugs_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"version" text NOT NULL,
	"git_ref" text,
	"status" "deployment_status" DEFAULT 'approved' NOT NULL,
	"requested_by_id" uuid,
	"deployed_by_id" uuid,
	"deployed_at" timestamp with time zone,
	"release_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "environment_kind" DEFAULT 'staging' NOT NULL,
	"url" text,
	"branch" text,
	"infra_resource_id" uuid,
	"status" "environment_status" DEFAULT 'unknown' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_technologies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"technology_id" uuid NOT NULL,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"task_id" uuid,
	"number" integer,
	"title" text NOT NULL,
	"branch" text,
	"target_branch" text,
	"author_id" uuid,
	"reviewer_id" uuid,
	"status" "pull_request_status" DEFAULT 'open' NOT NULL,
	"url" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_run_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"test_case_id" uuid NOT NULL,
	"status" "test_result_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"tested_by_id" uuid,
	"tested_at" timestamp with time zone,
	"bug_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"environment_id" uuid,
	"status" "qa_run_status" DEFAULT 'planned' NOT NULL,
	"assignee_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"summary" text,
	"total_count" integer DEFAULT 0 NOT NULL,
	"pass_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_runs_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "qa_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"title" text NOT NULL,
	"area" text,
	"steps" text,
	"expected_result" text,
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" "qa_category" DEFAULT 'general' NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"provider" "git_provider" DEFAULT 'github' NOT NULL,
	"url" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"branching_strategy" text,
	"is_private" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tech_debt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"repository_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"impact" "priority" DEFAULT 'medium' NOT NULL,
	"effort" "effort" DEFAULT 'medium' NOT NULL,
	"status" "tech_debt_status" DEFAULT 'open' NOT NULL,
	"owner_id" uuid,
	"due_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tech_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"project_id" uuid,
	"kind" "tech_review_kind" DEFAULT 'architecture' NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"decision" text,
	"status" "tech_review_status" DEFAULT 'draft' NOT NULL,
	"requested_by_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tech_reviews_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "technologies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" "technology_category" DEFAULT 'framework' NOT NULL,
	"is_standard" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technologies_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"template_item_id" uuid,
	"title" text NOT NULL,
	"area" text,
	"steps" text,
	"expected_result" text,
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_introduced_by_id_users_id_fk" FOREIGN KEY ("introduced_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_qa_run_id_qa_runs_id_fk" FOREIGN KEY ("qa_run_id") REFERENCES "public"."qa_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_deployed_by_id_users_id_fk" FOREIGN KEY ("deployed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_technologies" ADD CONSTRAINT "project_technologies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_technologies" ADD CONSTRAINT "project_technologies_technology_id_technologies_id_fk" FOREIGN KEY ("technology_id") REFERENCES "public"."technologies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_run_results" ADD CONSTRAINT "qa_run_results_run_id_qa_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."qa_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_run_results" ADD CONSTRAINT "qa_run_results_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_run_results" ADD CONSTRAINT "qa_run_results_tested_by_id_users_id_fk" FOREIGN KEY ("tested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_run_results" ADD CONSTRAINT "qa_run_results_bug_id_bugs_id_fk" FOREIGN KEY ("bug_id") REFERENCES "public"."bugs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_runs" ADD CONSTRAINT "qa_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_runs" ADD CONSTRAINT "qa_runs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_runs" ADD CONSTRAINT "qa_runs_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_runs" ADD CONSTRAINT "qa_runs_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_template_items" ADD CONSTRAINT "qa_template_items_template_id_qa_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."qa_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_debt" ADD CONSTRAINT "tech_debt_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_debt" ADD CONSTRAINT "tech_debt_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_debt" ADD CONSTRAINT "tech_debt_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_reviews" ADD CONSTRAINT "tech_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_reviews" ADD CONSTRAINT "tech_reviews_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_template_item_id_qa_template_items_id_fk" FOREIGN KEY ("template_item_id") REFERENCES "public"."qa_template_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bugs_project_idx" ON "bugs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "bugs_assignee_idx" ON "bugs" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "deploys_project_idx" ON "deployments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "deploys_env_idx" ON "deployments" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "envs_project_idx" ON "environments" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tech_uq" ON "project_technologies" USING btree ("project_id","technology_id");--> statement-breakpoint
CREATE INDEX "prs_repo_idx" ON "pull_requests" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "prs_reviewer_idx" ON "pull_requests" USING btree ("reviewer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_results_uq" ON "qa_run_results" USING btree ("run_id","test_case_id");--> statement-breakpoint
CREATE INDEX "qa_runs_project_idx" ON "qa_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "qa_tpl_items_tpl_idx" ON "qa_template_items" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "repos_project_idx" ON "repositories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "test_cases_project_idx" ON "test_cases" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_cases_tpl_uq" ON "test_cases" USING btree ("project_id","template_item_id");