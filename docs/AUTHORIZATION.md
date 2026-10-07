# Authorization

Authorization is enforced on the server for every request. The UI only hides what the API would refuse.

## Model

```
user ──< user_roles >── role ──< role_permissions (permission, scope) >
```

- **Permission** — `<group>.<action>`, e.g. `invoices.view`, `projects.approve`, `compensation.edit`.
  The catalog lives in `src/server/rbac/catalog.ts`; unknown keys are rejected.
- **Scope** — per grant: `own`, `team` or `all`. Each resource defines what `own`/`team` mean
  (e.g. employees: own = my record, team = my direct reports; tasks: own = assigned to me or in my projects).
  A user holding the same permission through several roles gets the widest scope.
- **Roles** — seeded from `src/server/rbac/defaults.ts` (CEO, CTO, PM, Developer, Designer, QA, Finance, BD,
  Marketing, HR, Admin, IT, Support) plus the `employee` base role every user holds. Grants are editable in
  Admin › Roles & permissions; custom roles can be created.

## Enforcement points

| Layer | Mechanism |
|---|---|
| Authentication | `onRequest` hook resolves the session cookie → `Actor` (roles + merged permissions) for every `/api` route except login/health. |
| Action level | `permFor(def, action)` + `actor.perms` — 403 when the permission is missing. |
| Record level | `scopeCondition()` adds the scope's SQL predicate to every list, read, update and delete. Out-of-scope IDs return **404** (no existence leak / IDOR). |
| Field level | `readPermission` fields are stripped from responses, CSV exports and metadata; `writePermission` fields return 403 when written without permission. |
| References | Writing a foreign key checks the target is visible to the actor (prevents attaching records to inaccessible parents). |
| Assignment | If a group has an `assign` action, users without it may only assign records to themselves. |
| Collaboration | Comments, files, activity and audit history require visibility of the parent record; uploads require edit access. |
| Notifications | Recipients who cannot view the referenced record are skipped. |
| Approvals | Only the designated approver (user or role) can decide; requesters cannot approve their own requests. |

## Anti-escalation rules

- Sensitive permissions (`users.*`, `roles.*`, `settings.*`, `audit.*`, `compensation.*`, `payroll.*`,
  `employees_sensitive.*`) can only be granted — or revoked — by someone who holds them at ≥ the same scope.
- Assigning a role to a user is checked the same way against every permission the role carries.
- Users cannot change their own roles, nor the permissions of a role they hold.
- Every permission and role change is written to the audit log with before/after values.

## Self-service (granted to every employee via the base role)
Own employee record (incl. own private fields and emergency contacts), own tasks/time/attendance/leave (create and
cancel), own expenses, own payslips and salary history, own equipment, licences and access records, own performance
review (self-assessment only), interviews assigned to them, goals and the knowledge base.

## Record-aware field restrictions
A field permission held at `own`/`team` scope only applies to rows inside that scope. Example: a PM with
`project_finance.view@own` sees budget and cost only on projects they manage, even though they can view all projects.

## Separation of duties
Approvals cannot be decided by the requester; expenses cannot be approved by their submitter; payroll cannot be
approved by its preparer; PR authors cannot approve their own PR; only QA can verify/close bugs; only HR can mark a
candidate as hired; publishing knowledge needs `kb.publish`.

## Sensitive data classes

| Data | Permission | Default holders |
|---|---|---|
| Employee private fields (DOB, home address, personal email, national ID) | `employees_sensitive.view/edit` | HR, CEO (view) |
| Salary / compensation | `compensation.view/edit` | Finance, HR (view), CEO (view) |
| Payroll | `payroll.*` | Finance, HR (view), CEO |
| Audit log | `audit.view` | Admin, CEO |

Admin (system administration) intentionally does **not** receive finance or private HR data by default.

## Default access matrix (from the blueprint)

| Role | Employees | Projects | Finance | HR | CRM |
|---|---|---|---|---|---|
| CEO | all (view) | full | full | view | full |
| CTO | view | full | project finance (view) | team | view |
| PM | team | full | own projects | team | clients |
| Developer | own | assigned | none | own | none |
| HR | full | view | payroll (view) | full | none |
| Finance | view | view (financial) | full | payroll | billing |
| BD | directory | handover (own) | quotes | none | full |

The authoritative definition is `ROLE_SEEDS` in `src/server/rbac/defaults.ts`; the live configuration is in
the database (Admin › Roles).
