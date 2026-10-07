import type { ComponentType } from 'react';
import { Link } from 'react-router';
import { useMeta } from '../lib/meta';
import { Card, PageHeader } from '../components/ui';
import { ApprovalsList } from './Inbox';

/** Role dashboards register here (see pages/dashboards). Falls back to the employee home. */
export const DASHBOARDS: Record<string, ComponentType> = {};

export function greeting(name: string) {
  const h = new Date().getHours();
  return `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${name.split(' ')[0]}`;
}

export function EmployeeHome() {
  const { user, resources } = useMeta();
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Here’s what needs your attention." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Waiting for your approval"><ApprovalsList compact /></Card>
        <Card title="Quick links">
          <ul className="grid grid-cols-2 gap-2 text-sm">
            {Object.values(resources).slice(0, 12).map((r) => <li key={r.key}><Link className="text-brand-700 hover:underline" to={`/r/${r.key}`}>{r.plural}</Link></li>)}
          </ul>
        </Card>
      </div>
    </>
  );
}

export function HomePage() {
  const { user } = useMeta();
  const D = DASHBOARDS[user.homeDashboard] ?? EmployeeHome;
  return <D />;
}
