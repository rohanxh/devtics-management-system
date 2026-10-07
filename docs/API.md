# API

JSON over HTTPS under `/api`. Authentication is a session cookie set by `POST /api/auth/login`.
Every mutating request must send `X-Requested-With: dms`. Errors have the shape
`{ "error": { "code": "...", "message": "...", "details": { "field": "message" } } }` with HTTP
400 (bad request), 401 (unauthenticated), 403 (forbidden / CSRF), 404 (not found or out of scope),
409 (conflict / in use), 422 (validation failed), 429 (rate limited), 500 (internal, with a reference id).

## Auth
| Method | Path | |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` → sets cookie; `{ok, mustChangePassword}` |
| POST | `/api/auth/logout` | revokes the session |
| GET | `/api/auth/me` | current user, roles, permissions (`{perm: scope}`) |
| POST | `/api/auth/change-password` | `{currentPassword, newPassword}` |

## API tokens (integrations)
Create personal tokens in the UI (user menu › API tokens) or via `POST /api/auth/tokens` `{name, expiresInDays}` from a
signed-in session; the secret is returned once. Call the API with `Authorization: Bearer dms_…` — no cookie and no CSRF
header. Tokens act with exactly the owner's permissions, expire (≤ 365 days), can be revoked (`DELETE /api/auth/tokens/:id`),
and cannot reach `/api/auth/*`. Only a SHA-256 hash is stored; creation and revocation are audited.

## Metadata & search
| GET | `/api/meta` | user, visible resources with field metadata and allowed actions, pipelines, public settings |
|---|---|---|
| GET | `/api/search?q=` | grouped, permission-filtered global search |
| GET/POST/DELETE | `/api/views` | per-user saved list views |

## Generic resources — `/api/r/:resource`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/r/:key` | `q`, `sort` (`field` / `-field`, comma-separated), `page`, `pageSize` (≤200), filters `field=value[,value]`, `field__gte=`, `field__lte=`, `field=__null`, `mine=1`, `id__in=` |
| GET | `/api/r/:key/:id` | record + `_labels` (reference titles) + `_can` (edit/delete on this record) |
| POST | `/api/r/:key` | create (201) |
| PATCH | `/api/r/:key/:id` | partial update; status transitions validated |
| DELETE | `/api/r/:key/:id` | soft or hard delete (409 if referenced) |
| POST | `/api/r/:key/bulk` | `{ids[], action: 'update'|'delete', data?}` — per-record authorization, per-record results |
| GET | `/api/r/:key/export.csv` | same filters as list; requires export permission |
| GET | `/api/r/:key/options` | `q`, `ids` → `[{id,label}]` for pickers |
| GET/POST | `/api/r/:key/:id/comments` | `{body, mentions?: userId[]}` |
| DELETE | `/api/comments/:id` | author only |
| GET/POST | `/api/r/:key/:id/files` | multipart upload (`file`), `?category=&expiresOn=` |
| GET/DELETE | `/api/files/:id` | authorized download / delete |
| GET | `/api/r/:key/:id/activity` | human-readable activity feed |
| GET | `/api/r/:key/:id/audit` | audit history (requires `audit.view`) |

The list of resources and their fields is discoverable at runtime from `/api/meta`.

## Notifications & approvals
| GET | `/api/notifications?unread=1` | latest 50 + unread count |
|---|---|---|
| POST | `/api/notifications/:id/read`, `/api/notifications/read-all` | |
| GET | `/api/approvals?status=&scope=mine|all` | |
| POST | `/api/approvals/:id/decide` | `{decision: 'approved'|'rejected', note}` (note required to reject) |

## Administration
| GET | `/api/admin/permissions` | permission catalog |
|---|---|---|
| GET/POST | `/api/admin/roles` | list (with grants) / create |
| PUT | `/api/admin/roles/:id/permissions` | `{grants: [{permission, scope}]}` |
| DELETE | `/api/admin/roles/:id` | non-system roles without users |
| POST | `/api/admin/users` | `{name, email, roleKeys[], employeeId?}` → `{id, temporaryPassword}` |
| GET/PUT | `/api/admin/users/:id/roles` | |
| POST | `/api/admin/users/:id/reset-password` | → `{temporaryPassword}` |
| GET | `/api/admin/audit` | filters: `table, action, actor, record, from, to, page` |
| GET/PATCH | `/api/admin/automation[/:id]` | rules + action catalog; enable/disable, edit conditions/actions |
| GET/PUT | `/api/admin/settings` | |

Module-specific endpoints are documented in the sections below as modules are added.

## Sales & delivery
| Method | Path | |
|---|---|---|
| POST | `/api/sales/leads/:id/convert` | `{opportunityName?, value?, expectedCloseDate?}` → opportunity (201) |
| GET | `/api/projects/:projectId/onboarding` | onboarding state + allowed actions |
| POST | `/api/onboarding/:id/handover` | `{handoverNotes}` |
| POST | `/api/onboarding/:id/pm-review` | `{pmId, techLeadId?, memberIds?, dueDate?, budgetHours?, pmNotes?}` |
| POST | `/api/onboarding/:id/complete` | start delivery |
| GET | `/api/my-work` | the caller's open tasks grouped (overdue/today/upcoming) + projects |
| GET | `/api/dashboard/:key` | role dashboards: `ceo`, `cto`, `pm`, `developer`, `qa`, `finance`, `bd`, `hr`, `it`, `marketing`, `support` (each permission-gated) |

## Engineering & QA
| Method | Path | |
|---|---|---|
| POST | `/api/qa/runs` | `{projectId, name, templateIds[], includeProjectCases, environmentId?, assigneeId?}` |
| GET | `/api/qa/runs/:id/results` | results with test-case details and linked bugs |
| POST | `/api/qa/results/:id/fail` | `{title, severity, actualResult?, stepsToReproduce?, assigneeId?}` → bug (201) |
| POST | `/api/qa/runs/:id/complete`, `/approve`, `/reject` | run lifecycle; approve = QA sign-off |
| POST | `/api/projects/:id/launch` | requires QA sign-off |

## Finance
| POST | `/api/finance/invoices/from-milestone/:id` | draft invoice for a billable milestone |
|---|---|---|
| POST | `/api/finance/payroll-runs` | `{periodStart, periodEnd}` → draft run with payslips |
| POST | `/api/finance/payroll-runs/:id/approve`, `/paid` | approval (not the preparer) / mark paid |
| GET | `/api/finance/profitability` | project profitability (scoped by `project_finance.view`) |
| GET | `/api/finance/pnl?from=&to=` | P&L, monthly series, receivables, MRR |

## HR
| GET | `/api/attendance/me` | today, month summary, leave balances |
|---|---|---|
| POST | `/api/attendance/clock-in` (`{remote?}`), `/api/attendance/clock-out` | own attendance |
| GET | `/api/attendance/day?date=` | team/all attendance for a date (scoped) |

## Support
| POST | `/api/support/tickets/:id/escalate` | `{kind: 'task'|'bug', assigneeId?, severity?}` |
|---|---|---|
| GET | `/api/support/plans/usage` | hours used/remaining this month per active plan |

## Knowledge base
| GET | `/api/kb?q=&category=` | articles visible to the caller (+ read/ack status) |
|---|---|---|
| GET | `/api/kb/my-reading` | pending required reading |
| GET | `/api/kb/:idOrSlug?draft=1&version=` | article + version body + versions + permissions |
| POST | `/api/kb` | create (draft v1) |
| PUT | `/api/kb/:id/draft` | save working draft (new version after publish) |
| PUT | `/api/kb/:id/audience` | `{roleKeys[], departmentIds[]}` |
| POST | `/api/kb/:id/publish` | publish latest draft; assigns required reading |
| POST | `/api/kb/:id/acknowledge` | acknowledge current version |
| GET | `/api/kb/:id/compliance` | acknowledgement status per assigned user |

## Reports
| GET | `/api/reports` | reports available to the caller |
|---|---|---|
| GET | `/api/reports/:key?from=&to=` | `financial`, `profitability`, `sales`, `projects`, `utilization`, `hr`, `technical`, `support`, `departments` |
