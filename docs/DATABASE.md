# Database

PostgreSQL schema managed by Drizzle (`src/server/db/schema/*.ts`) with SQL migrations in `drizzle/`.
Conventions: snake_case columns, UUID primary keys (`gen_random_uuid()`), `created_at`/`updated_at`
timestamps (timestamptz), money as `numeric(14,2)`, enums for fixed vocabularies, foreign keys everywhere a
relationship exists, indexes on foreign keys used for filtering.

## Core (Phase 1)
| Table | Purpose |
|---|---|
| `users` | Login identities (email unique case-insensitively, scrypt hash, status, lockout fields). |
| `roles`, `user_roles`, `role_permissions` | RBAC; grants carry a scope (`own`/`team`/`all`). |
| `sessions` | Server-side sessions (token SHA-256, expiry, revocation). |
| `departments`, `designations`, `locations`, `work_schedules`, `holidays` | Organisation structure. |
| `employees` | HR person record (1:0..1 with users), department/designation/manager/location, employment status; private fields are field-level restricted. |
| `settings` | Key/value system settings (JSONB). |
| `pipeline_stages` | Configurable stages for all pipelines (`pipeline`, stable `key`, name, order, colour, terminal/outcome). |
| `audit_logs` | Append-only audit trail (trigger + app events). |
| `domain_events` | Transactional outbox. |
| `automation_rules` | Event → conditions → actions (JSONB config). |
| `notifications` | In-app notifications with per-user dedupe key. |
| `comments`, `activities`, `files` | Polymorphic collaboration attached by `(entity_type, entity_id)`. |
| `approvals` | Generic approval requests. |
| `saved_views` | Per-user saved list filters. |
| `counters` | Atomic counters for document numbers. |

## Design notes
- **One canonical entity per concept.** Modules reference shared tables rather than copying them.
- **Polymorphic tables** do not have FKs to their parents (by design); integrity of access is enforced by
  the parent resource's authorization. Orphans are harmless and can be swept.
- **JSONB is used only for genuinely flexible data**: settings values, automation rule config, audit
  snapshots, event payloads, saved-view queries.
- **Audit triggers** are attached to every public table except high-volume/system tables
  (`audit_logs`, `domain_events`, `notifications`, `sessions`, `activities`, `saved_views`).

Module tables are documented in their sections as they are added.

## CRM & sales (Phase 2)
| Table | Purpose |
|---|---|
| `companies` | **Canonical organisation** (prospect, client, former client, partner, vendor). Client fields: code, since, account manager, billing email, payment terms, health/score/reasons. The *Clients* module is a filtered view (`lifecycle in (client, former_client)`) of this same table. |
| `contacts` | People at companies. |
| `leads` | Top of funnel (new → contacted → qualified → converted / unqualified), source, owner, estimated value. |
| `opportunities` | Deals on the configurable `sales` pipeline (Discovery → Requirement → Proposal → Negotiation → Won/Lost); value, probability, close date, won/lost timestamps, link to the onboarded project. |
| `requirements` | MoSCoW requirements per opportunity. |
| `communications` | Calls/emails/meetings/notes with explicit FKs to company, contact, lead, opportunity, project. |
| `follow_ups` | Dated follow-up reminders. |
| `quotes`, `quote_items` | Priced quotes; totals computed in SQL (`recalcTotals`). |
| `proposals` | Proposal documents (versioned). |
| `contracts` | MSAs, SOWs (type `sow`, optional parent MSA), NDAs, maintenance agreements. |
| `sales_targets`, `commissions` | Targets per person/team & period; commission per deal. |

## Delivery (Phase 3)
| Table | Purpose |
|---|---|
| `projects` | Lifecycle `stage_id` (pipeline `project`: Scope → Design → Development → QA → Client Feedback → Launch → Maintenance → Closed) and delivery `status` (On track, At risk, Delayed, Awaiting client/design/development, In QA, Ready for launch…). Links client, deal, contract; budget (field-restricted). |
| `project_members` | Resources: who works on a project, role, allocation. |
| `milestones` | Dated, optionally billable milestones. |
| `tasks` | Tasks & subtasks (`parent_task_id`), assignee, estimate, rework flag, QA rejection count. |
| `task_dependencies` | Finish-to-start dependencies (cycle-checked with a recursive CTE). |
| `task_checklist_items` | Checklists. |
| `time_entries` | Time tracking with **cost snapshot** from the salary history at logging time. |
| `risks` | Risks & issues; `project_id NULL` = company-level risk register. |
| `change_requests` | Scope changes with impact (hours/cost/days) and approval. |
| `meeting_notes`, `project_updates`, `client_feedback` | Communication, daily/weekly/client updates, escalations, client review requests & satisfaction. |
| `project_onboardings` | Won-deal onboarding workflow state (BD → PM → CTO → Development). |
| `employee_compensation` | Effective-dated salary history incl. hourly cost (finance-restricted). |

## Engineering & QA (Phase 4)
| Table | Purpose |
|---|---|
| `repositories`, `environments` | Code repositories and dev/staging/production environments per project (environment → infra record). |
| `pull_requests` | Code reviews (author ≠ reviewer), linked to tasks. |
| `deployments` | Deployment history; production requires CTO approval (`pending_approval → approved → succeeded/failed`). |
| `bugs` | Severity, priority, steps, expected/actual, fix/QA status, introduced-by, retest count; links to QA run/test case/ticket. |
| `qa_templates`, `qa_template_items` | Reusable QA checklists (seeded library). |
| `test_cases`, `qa_runs`, `qa_run_results` | Project test cases, test cycles, per-case results (pass/fail/blocked/skipped) with linked bugs. |
| `tech_reviews`, `tech_debt`, `technologies`, `project_technologies` | CTO approvals, debt register, technology standards and per-project stack. |

## Finance (Phase 5)
| Table | Purpose |
|---|---|
| `invoices`, `invoice_items` | Client invoices; totals in SQL; `amount_paid`/`balance_due`/status derived from payments. |
| `payments` | Receipts against invoices (overpayment rejected). |
| `recurring_billing` | Schedules that draft invoices (retainers, maintenance plans). |
| `expenses` | Expenses/payables by category; project link drives infrastructure/other cost. |
| `payroll_runs`, `payroll_items`, `employee_adjustments` | Payroll from salary history + approved bonuses/deductions/advances. |

## HR & strategy (Phase 6)
| Table | Purpose |
|---|---|
| `emergency_contacts`, `skills`, `employee_skills`, `certifications`, `employee_job_history` | Employee records; promotions/transfers update the employee. |
| `attendance_records` | One row per employee/day: clock in/out, worked/late/early/overtime minutes, status, source. |
| `leave_types`, `leave_balances`, `leave_requests` | Leave policy, per-year balances, requests linked to approvals. |
| `performance_reviews`, `trainings` | Reviews (self → manager → completed) and training records. |
| `job_openings`, `candidates`, `applications`, `interviews` | Recruitment pipeline (configurable `recruitment` stages). |
| `goals`, `kpis`, `kpi_values`, `initiatives` | OKRs/targets (optionally auto-measured), KPI history, strategic initiatives. |

## IT (Phase 7)
| Table | Purpose |
|---|---|
| `assets`, `asset_assignments` | Equipment and assignment history. |
| `subscriptions`, `license_assignments` | SaaS/licenses with seats. `vault_reference` points to the password manager — **no secrets stored**. |
| `infra_resources` | Domains, hosting, servers, cloud accounts, SSL, APIs, DNS with expiry. |
| `access_grants` | Who has access to which system (onboarding/offboarding). |

## Marketing (Phase 8)
`campaigns` (lead attribution via `leads.campaign_id`), `traffic_snapshots`, `seo_keywords`, `keyword_rankings`,
`backlinks`, `seo_audits`, `content_items` (pipeline `content`).

## Support (Phase 9)
`sla_policies`, `sla_targets` (per priority), `maintenance_plans` (hours, fee → recurring billing), `tickets`
(SLA due times, breach flag, links to task/bug; `time_entries.ticket_id` drives plan usage).

## Knowledge (Phase 10)
`kb_articles` (→ current published version), `kb_article_versions`, `kb_article_audiences` (roles/departments),
`kb_reading_assignments` (per version & user, due date), `kb_acknowledgements` (per version & user).
