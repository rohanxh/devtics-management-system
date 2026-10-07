# Security

DMS holds sensitive business, financial and HR data. Controls below reference OWASP ASVS / Top 10 categories.

## Authentication & sessions
- Passwords hashed with **scrypt** (N=2^17, r=8, p=1, 16-byte salt) per the OWASP Password Storage Cheat Sheet;
  comparison with `timingSafeEqual`. No password is ever stored or logged in plain text.
- Password policy follows NIST SP 800-63B: minimum 12 characters, no composition rules, rejects trivial values
  and passwords containing the email name.
- Unknown email and wrong password return the same message; a dummy hash keeps timing similar.
- Account lockout: 5 failures → locked 15 minutes. Login and password change are rate-limited per IP
  (`AUTH_RATE_PER_MIN`, default 10/min).
- Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Lax`, `Secure` (production) cookie; only the SHA-256
  of the token is stored. Idle timeout (`SESSION_IDLE_HOURS`, default 12h) and absolute lifetime
  (`SESSION_MAX_DAYS`, default 7d). Logout revokes server-side; password change/reset revokes other sessions.
- New users and admin resets get a random temporary password shown once to the admin and must change it at first
  sign-in (all other API calls return 403 until they do).

## API tokens
Bearer tokens (`dms_` + 256-bit random) for integrations: hashed at rest, expiring, revocable, owner-scoped permissions,
unable to manage sessions/tokens, creation/revocation audited (`API_TOKEN_CREATED/REVOKED`). Requests with a Bearer token
ignore cookies, so they are not exposed to CSRF.

## Request protection
- **CSRF**: every mutating `/api` request must carry `X-Requested-With: dms` (cannot be sent cross-origin without
  CORS, which is not enabled) and, when an `Origin` header is present, it must match `APP_ORIGIN`.
- **Security headers** (Helmet): strict CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`,
  `object-src 'none'`), `X-Content-Type-Options: nosniff`, HSTS, Referrer-Policy, etc.
- **Injection**: all SQL goes through Drizzle's parameterised queries; dynamic identifiers come only from
  server-side resource definitions, never from request input. `ILIKE` input is escaped.
- **XSS**: React escapes output; URL fields only accept `http(s)` (blocks `javascript:`); no `dangerouslySetInnerHTML`.
- **Mass assignment**: only declared, writable fields are accepted; read-only/workflow fields are ignored.
- **CSV injection**: exported cells beginning with `= + - @` are prefixed with `'`.
- Body size limit 2 MB (JSON), uploads 25 MB.

## Access control
See AUTHORIZATION.md. Highlights: server-side enforcement at action, record and field level; 404 for out-of-scope
records (IDOR); anti-escalation rules for permission grants; self-approval blocked.

## Files
- Stored outside any web root under random UUID keys (`STORAGE_DIR`), never at predictable public URLs.
- Download only via `GET /api/files/:id`, which checks visibility of the parent record each time.
- Extension allow-list (SVG/HTML excluded); magic-byte verification for images and PDFs; SHA-256 recorded.
- Downloads are served with `Content-Security-Policy: sandbox`, `nosniff`, `Cache-Control: private, no-store`,
  and `Content-Disposition: attachment` except for safe inline types (PDF, raster images, video).

## Audit
- Database triggers record every insert/update/delete on business tables with actor, request id, before/after
  JSON and changed fields — including changes made outside the API. Password and token hashes are redacted.
- `audit_logs` is append-only (UPDATE/DELETE/TRUNCATE raise exceptions). In production, additionally run the
  application with a DB role that is not the table owner so triggers cannot be dropped by the app.
- Application events: LOGIN, LOGIN_FAILED, LOGOUT, PASSWORD_CHANGED, PASSWORD_RESET, USER_CREATED,
  ROLES_CHANGED, PERMISSIONS_CHANGED.

## Sensitive data handling (selected controls)
- Field permissions held at `own`/`team` scope apply only to rows in that scope, for both reads and writes
  (e.g. employees can see/edit their own private HR fields; managers cannot see their reports').
- Private employee documents (categories `contract`, `id`, `medical`, `payroll`, `private`) are hidden from everyone except
  HR-sensitive holders and the employee — in listings and downloads.
- Payroll totals are hidden from employees who can only see their own payslip; compensation is own-record only for staff.
- Expected salaries of candidates are hidden from hiring managers/interviewers.

## Secrets & credentials
- No secrets in the repository; configuration via environment variables (`.env` is gitignored; see `.env.example`).
- Demo seed passwords are random unless `SEED_PASSWORD` is provided, and are written only to the gitignored `.data/`.
- **Raw passwords for company systems must never be stored in DMS.** Infrastructure, subscription and access records hold a
  *reference* to the password-manager entry (`op://…`, `bw://…`, `keeper://…`, `https://` vault link), enforced by validation.
  Notes/identifier fields on IT, repository and environment records reject values that look like credentials (private keys,
  AWS/GitHub/Stripe/Slack/Google keys, `password: …`, `token = …`).

## Operational recommendations
- Terminate TLS at a reverse proxy; set `NODE_ENV=production` (enables `Secure` cookies and `trustProxy`).
- Use a dedicated Postgres role with least privilege; enable automated backups and point-in-time recovery.
- Back up `STORAGE_DIR` alongside the database.
- Rotate the SMTP credentials and any integration tokens through your secret manager.

## Known limitations / follow-ups
- No MFA yet (recommended next: TOTP for privileged roles).
- No self-service password reset by email (admins reset passwords).
- Rate limiting is per process (in-memory store); use a shared store when running multiple instances.
- Antivirus scanning of uploads is not integrated.
