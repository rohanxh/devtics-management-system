import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api, ApiError, setUnauthorizedHandler } from './lib/api';
import { MetaContext, type Meta } from './lib/meta';
import { ToastProvider } from './components/toast';
import { Layout } from './components/Layout';
import { ErrorState, Spinner } from './components/ui';
import { ChangePasswordPage, LoginPage } from './pages/Auth';
import { HomePage } from './pages/Home';
import { RecordPage, ResourceListPage } from './pages/ResourcePages';
import { ApprovalsPage, NotificationsPage } from './pages/Inbox';
import { AuditPage, AutomationAdminPage, RolesAdminPage, SettingsPage, UsersAdminPage } from './pages/Admin';
import { EXTRA_ROUTES } from './lib/extensions';
import './modules/index';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function Shell() {
  const navigate = useNavigate();
  setUnauthorizedHandler(() => { queryClient.clear(); navigate('/login', { replace: true }); });
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/api/meta'), staleTime: 5 * 60_000 });
  if (meta.isLoading) return <Spinner label="Loading workspace…" />;
  if (meta.error instanceof ApiError && meta.error.status === 401) return <Navigate to="/login" replace />;
  if (meta.error instanceof ApiError && meta.error.code === 'password_change_required') return <ChangePasswordPage forced />;
  if (meta.isError) return <ErrorState error={meta.error} retry={() => meta.refetch()} />;
  return (
    <MetaContext.Provider value={meta.data!}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="r/:key" element={<ResourceListPage />} />
          <Route path="r/:key/:id" element={<RecordPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="change-password" element={<ChangePasswordPage />} />
          <Route path="admin/users" element={<UsersAdminPage />} />
          <Route path="admin/roles" element={<RolesAdminPage />} />
          <Route path="admin/automation" element={<AutomationAdminPage />} />
          <Route path="admin/audit" element={<AuditPage />} />
          <Route path="admin/settings" element={<SettingsPage />} />
          {EXTRA_ROUTES.map((r) => <Route key={r.path} path={r.path} element={<r.component />} />)}
          <Route path="*" element={<ErrorState error={{ status: 404, message: 'This page does not exist.' }} />} />
        </Route>
      </Routes>
    </MetaContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/*" element={<Shell />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
