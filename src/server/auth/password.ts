import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

// OWASP Password Storage Cheat Sheet: scrypt N=2^17, r=8, p=1.
// DMS_FAST_HASH lowers the cost for the automated test suite only; verification reads N from the stored hash.
const N = process.env.DMS_FAST_HASH === "1" && process.env.NODE_ENV !== "production" ? 2 ** 12 : 2 ** 17, r = 8, p = 1, KEYLEN = 64;
const OPTS = { N, r, p, maxmem: 256 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, OPTS);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, n, rr, pp, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(rr), p: Number(pp), maxmem: 256 * 1024 * 1024,
  });
  return timingSafeEqual(key, expected);
}

/** Used to keep login timing constant when the email does not exist. */
let dummyHash: Promise<string> | undefined;
export const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing'));

/** NIST SP 800-63B: length over composition rules; block trivially weak choices. */
export function passwordProblems(pw: string, email?: string): string | null {
  if (pw.length < 12) return 'Password must be at least 12 characters';
  if (pw.length > 256) return 'Password is too long';
  const lower = pw.toLowerCase();
  if (email && lower.includes(email.split('@')[0].toLowerCase())) return 'Password must not contain your email name';
  if (/^(.)\1+$/.test(pw) || ['password1234', '123456789012', 'qwertyuiopas'].includes(lower)) return 'Password is too common';
  return null;
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
