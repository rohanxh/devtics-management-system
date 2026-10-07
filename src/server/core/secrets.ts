/**
 * DMS must never store raw credentials. Fields that might attract them are scanned for common secret
 * shapes, and "vault reference" fields only accept pointers to a password-manager entry.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/, // Stripe
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\b(password|passwd|pwd|passcode|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token)\s*[:=]\s*\S{4,}/i,
];

export const looksLikeSecret = (v: string) => SECRET_PATTERNS.some((re) => re.test(v));

/** Accepted password-manager references, e.g. op://Devtics/Figma/admin, bw://item-id, https://vault.example/… */
export const VAULT_REFERENCE = /^((op|bw|bitwarden|keeper|lastpass|dashlane|vault):\/\/\S{3,200}|https:\/\/\S{3,500})$/i;
