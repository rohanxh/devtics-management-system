CREATE TYPE "public"."access_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."access_system" AS ENUM('email', 'github', 'hosting', 'project_management', 'crm', 'cloud', 'design', 'communication', 'dms', 'other');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('laptop', 'desktop', 'monitor', 'phone', 'tablet', 'accessory', 'network', 'other');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('in_stock', 'assigned', 'in_repair', 'retired', 'lost');--> statement-breakpoint
CREATE TYPE "public"."billing_cycle" AS ENUM('monthly', 'quarterly', 'yearly', 'one_time');--> statement-breakpoint
CREATE TYPE "public"."infra_kind" AS ENUM('domain', 'hosting', 'server', 'cloud_account', 'ssl_certificate', 'api', 'dns_zone', 'email', 'other');--> statement-breakpoint
CREATE TYPE "public"."infra_status" AS ENUM('active', 'expiring', 'expired', 'decommissioned');--> statement-breakpoint
CREATE TYPE "public"."subscription_category" AS ENUM('saas', 'license', 'api', 'other');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'trial', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"system" "access_system" NOT NULL,
	"system_name" text NOT NULL,
	"subscription_id" uuid,
	"infra_resource_id" uuid,
	"account_identifier" text,
	"access_level" text,
	"status" "access_status" DEFAULT 'active' NOT NULL,
	"granted_on" date,
	"revoked_on" date,
	"granted_by_id" uuid,
	"revoked_by_id" uuid,
	"vault_reference" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"assigned_on" date NOT NULL,
	"returned_on" date,
	"condition_out" text,
	"condition_in" text,
	"assigned_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag" text NOT NULL,
	"kind" "asset_kind" DEFAULT 'laptop' NOT NULL,
	"brand" text,
	"model" text,
	"serial_number" text,
	"purchase_date" date,
	"purchase_cost" numeric(14, 2),
	"vendor" text,
	"warranty_until" date,
	"status" "asset_status" DEFAULT 'in_stock' NOT NULL,
	"assigned_employee_id" uuid,
	"assigned_on" date,
	"condition" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_tag_unique" UNIQUE("tag")
);
--> statement-breakpoint
CREATE TABLE "infra_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "infra_kind" NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"identifier" text,
	"region" text,
	"project_id" uuid,
	"company_id" uuid,
	"expires_on" date,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"cost" numeric(14, 2),
	"billing_cycle" "billing_cycle",
	"status" "infra_status" DEFAULT 'active' NOT NULL,
	"owner_id" uuid,
	"vault_reference" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"account_identifier" text,
	"assigned_on" date NOT NULL,
	"revoked_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"vendor" text,
	"category" "subscription_category" DEFAULT 'saas' NOT NULL,
	"plan" text,
	"billing_cycle" "billing_cycle" DEFAULT 'monthly' NOT NULL,
	"cost" numeric(14, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"seats_total" integer,
	"seats_used" integer DEFAULT 0 NOT NULL,
	"renewal_date" date,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"owner_id" uuid,
	"vault_reference" text,
	"url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_infra_resource_id_infra_resources_id_fk" FOREIGN KEY ("infra_resource_id") REFERENCES "public"."infra_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_granted_by_id_users_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_revoked_by_id_users_id_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assigned_by_id_users_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_employee_id_employees_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_resources" ADD CONSTRAINT "infra_resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_resources" ADD CONSTRAINT "infra_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_resources" ADD CONSTRAINT "infra_resources_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_assignments" ADD CONSTRAINT "license_assignments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_assignments" ADD CONSTRAINT "license_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_emp_idx" ON "access_grants" USING btree ("employee_id","status");--> statement-breakpoint
CREATE INDEX "asset_assign_asset_idx" ON "asset_assignments" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "assets_employee_idx" ON "assets" USING btree ("assigned_employee_id");--> statement-breakpoint
CREATE INDEX "infra_kind_idx" ON "infra_resources" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "infra_expires_idx" ON "infra_resources" USING btree ("expires_on");--> statement-breakpoint
CREATE INDEX "license_assign_sub_idx" ON "license_assignments" USING btree ("subscription_id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_infra_resource_id_infra_resources_id_fk" FOREIGN KEY ("infra_resource_id") REFERENCES "public"."infra_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_infra_resource_id_infra_resources_id_fk" FOREIGN KEY ("infra_resource_id") REFERENCES "public"."infra_resources"("id") ON DELETE no action ON UPDATE no action;