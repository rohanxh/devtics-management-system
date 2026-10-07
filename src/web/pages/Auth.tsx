import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Field } from '../components/ui';
import { useToast } from '../components/toast';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const login = useMutation({
    mutationFn: () => api.post<{ mustChangePassword: boolean }>('/api/auth/login', { email, password }),
    onSuccess: async (r) => {
      await qc.invalidateQueries();
      navigate(r.mustChangePassword ? '/change-password' : '/', { replace: true });
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); login.mutate(); };
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-lg bg-brand-600 text-base font-bold text-white">D</span>
          <span className="text-lg font-semibold text-slate-900">Devtics Management System</span>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6 shadow-sm">
          <h1 className="text-base font-semibold">Sign in</h1>
          {login.isError && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{(login.error as Error).message}</p>}
          <Field label="Work email" htmlFor="email">
            <input id="email" type="email" autoComplete="username" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password" htmlFor="password">
            <input id="password" type="password" autoComplete="current-password" required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button variant="primary" type="submit" className="w-full" loading={login.isPending}>Sign in</Button>
          <p className="text-center text-xs text-slate-500">Forgot your password? Ask an administrator to reset it.</p>
        </form>
      </div>
    </div>
  );
}

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const change = useMutation({
    mutationFn: () => api.post('/api/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: async () => { toast.success('Password changed. Other sessions were signed out.'); await qc.invalidateQueries(); navigate('/', { replace: true }); },
    onError: (e) => { if (e instanceof ApiError && e.details) setErrors(e.details); else toast.error(e); },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { setErrors({ confirm: 'Passwords do not match' }); return; }
    setErrors({});
    change.mutate();
  };
  return (
    <div className={forced ? 'flex min-h-dvh items-center justify-center bg-slate-100 px-4' : ''}>
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <h1 className="text-base font-semibold">{forced ? 'Set a new password' : 'Change password'}</h1>
        {forced && <p className="text-sm text-slate-600">You’re using a temporary password. Choose a new one to continue.</p>}
        <Field label="Current password" htmlFor="cur" error={errors.currentPassword}>
          <input id="cur" type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="New password" htmlFor="new" error={errors.newPassword} help="At least 12 characters. A passphrase works well.">
          <input id="new" type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
        </Field>
        <Field label="Confirm new password" htmlFor="conf" error={errors.confirm}>
          <input id="conf" type="password" autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <Button variant="primary" type="submit" className="w-full" loading={change.isPending}>Update password</Button>
      </form>
    </div>
  );
}
