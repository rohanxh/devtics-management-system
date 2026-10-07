export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, string>;
  constructor(status: number, code: string, message: string, details?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized: (() => void) | undefined;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-requested-with': 'dms',
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && url !== '/api/auth/login') onUnauthorized?.();
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`, err.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T = any>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T = any>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
};

export const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
