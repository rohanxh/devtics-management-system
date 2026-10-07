import { ALL_PERMISSIONS, PERMISSION_GROUPS, type Scope } from './catalog.ts';

/**
 * Default role → permission grants, seeded on first run and editable afterwards in Admin › Roles.
 * Syntax: "group.action" or "group.*", optional "@own" / "@team" scope suffix (default "all").
 * Every user also holds the `employee` base role.
 */
export interface RoleSeed {
  key: string;
  name: string;
  description: string;
  homeDashboard: string;
  grants: string[];
}

const BASE = [
  'employees.view@own', 'tasks.view@own', 'tasks.edit@own', 'tasks.create@own',
  'time.view@own', 'time.create@own', 'time.edit@own', 'time.delete@own',
  'attendance.view@own', 'attendance.create@own', 'leave.view@own', 'leave.create@own',
  'performance.view@own', 'goals.view', 'kb.view', 'projects.view@own', 'org.view',
  'payroll.view@own', 'compensation.view@own', 'expenses.view@own', 'expenses.create@own',
  'employees_sensitive.view@own', 'employees_sensitive.edit@own', 'recruitment.view@own', 'recruitment.edit@own',
  'leave.edit@own', 'performance.edit@own',
];

const DELIVERY_IC = [
  'dev.view@own', 'dev.create@own', 'dev.edit@own', 'bugs.view@own', 'bugs.create', 'bugs.edit@own',
  'qa.view@own', 'tech.view', 'tickets.view@own', 'tickets.edit@own',
];

export const ROLE_SEEDS: RoleSeed[] = [
  {
    key: 'employee', name: 'Employee (base)', homeDashboard: 'employee',
    description: 'Baseline access every employee receives: own profile, tasks, time, attendance, leave and the knowledge base.',
    grants: BASE,
  },
  {
    key: 'ceo', name: 'CEO / Founder', homeDashboard: 'ceo',
    description: 'Company-wide oversight and decision-making. Broad read access, approvals, strategy and finance.',
    grants: [
      ...ALL_PERMISSIONS.filter((p) => p.endsWith('.view')),
      'reports.*', 'goals.*', 'projects.approve', 'qa.approve', 'dev.approve', 'tech.approve', 'expenses.approve',
      'payroll.approve', 'leave.approve', 'sales_docs.approve', 'kb.publish',
      'companies.*', 'leads.*', 'opportunities.*', 'clients.*', 'sales_docs.*', 'sales_targets.*',
      'invoices.*', 'payments.*', 'expenses.*', 'projects.*',
    ],
  },
  {
    key: 'cto', name: 'CTO', homeDashboard: 'cto',
    description: 'Technical leadership: delivery capacity, architecture, infrastructure, QA and technical approvals.',
    grants: [
      'employees.view', 'projects.*', 'project_finance.view', 'tasks.*', 'time.view', 'dev.*', 'bugs.*',
      'qa.view', 'qa.approve', 'tech.*', 'infrastructure.*', 'software.view', 'assets.view', 'access.view',
      'clients.view', 'companies.view', 'opportunities.view', 'sales_docs.view', 'tickets.*', 'maintenance.view',
      'reports.technical', 'reports.projects', 'approvals.view', 'kb.*', 'attendance.view@team', 'leave.view@team',
      'leave.approve', 'performance.view@team', 'performance.create', 'performance.edit@team',
    ],
  },
  {
    key: 'pm', name: 'Project Manager', homeDashboard: 'pm',
    description: 'Runs delivery: projects, milestones, tasks, risks, change requests and client communication.',
    grants: [
      'employees.view@team', 'projects.view', 'projects.create', 'projects.edit', 'projects.assign', 'projects.export',
      'project_finance.view@own', 'tasks.*', 'time.view@team', 'dev.view', 'bugs.*', 'qa.view', 'tech.view',
      'clients.view', 'clients.edit', 'companies.view', 'companies.create', 'companies.edit', 'opportunities.view',
      'sales_docs.view', 'invoices.view@own', 'tickets.*', 'maintenance.view', 'kb.create', 'kb.edit@own',
      'reports.projects', 'attendance.view@team', 'leave.view@team', 'leave.approve', 'performance.view@team',
    ],
  },
  {
    key: 'developer', name: 'Developer', homeDashboard: 'developer',
    description: 'Focused “My Work” access to assigned projects, tasks, bugs, code reviews and deployments.',
    grants: [...DELIVERY_IC],
  },
  {
    key: 'designer', name: 'Designer', homeDashboard: 'developer',
    description: 'Design work on assigned projects and tasks.',
    grants: ['bugs.view@own', 'bugs.create', 'qa.view@own', 'tickets.view@own', 'tickets.edit@own'],
  },
  {
    key: 'qa', name: 'QA Engineer', homeDashboard: 'qa',
    description: 'Quality assurance: test cases, QA runs, bug reports, retesting and QA sign-off.',
    grants: ['projects.view', 'tasks.view', 'tasks.create', 'dev.view', 'bugs.*', 'qa.*', 'tickets.view', 'tickets.edit', 'tech.view', 'kb.create', 'kb.edit@own'],
  },
  {
    key: 'finance', name: 'Finance', homeDashboard: 'finance',
    description: 'Invoicing, payments, expenses, payroll and profitability. No access to private HR records.',
    grants: [
      'employees.view', 'compensation.*', 'payroll.*', 'invoices.*', 'payments.*', 'expenses.*',
      'clients.view', 'clients.edit', 'companies.view', 'sales_docs.view', 'opportunities.view',
      'projects.view', 'project_finance.view', 'time.view', 'software.view', 'infrastructure.view',
      'maintenance.view', 'reports.finance', 'sales_targets.view',
    ],
  },
  {
    key: 'bd', name: 'Business Development / Sales', homeDashboard: 'bd',
    description: 'Lead → client journey: CRM, pipeline, quotes, proposals, contracts and handover.',
    grants: [
      'employees.view', 'companies.*', 'leads.*', 'opportunities.*', 'sales_docs.view', 'sales_docs.create',
      'sales_docs.edit', 'sales_targets.view@own', 'clients.view', 'clients.create', 'clients.edit',
      'projects.view@own', 'marketing.view', 'reports.sales', 'kb.create', 'kb.edit@own',
    ],
  },
  {
    key: 'marketing', name: 'SEO / Marketing', homeDashboard: 'marketing',
    description: 'Campaigns, SEO, content pipeline and lead generation.',
    grants: ['marketing.*', 'leads.view', 'leads.create', 'companies.view', 'reports.marketing', 'kb.create', 'kb.edit@own'],
  },
  {
    key: 'hr', name: 'HR', homeDashboard: 'hr',
    description: 'People operations: employees, attendance, leave, performance and recruitment.',
    grants: [
      'employees.*', 'employees_sensitive.*', 'compensation.view', 'payroll.view', 'attendance.*', 'leave.*',
      'performance.*', 'recruitment.*', 'org.*', 'goals.create', 'goals.edit', 'projects.view', 'reports.hr',
      'kb.*', 'assets.view', 'access.view',
    ],
  },
  {
    key: 'admin', name: 'Admin / Operations', homeDashboard: 'admin',
    description: 'System administration: users, roles, org structure, settings and automation. No financial or private HR data by default.',
    grants: ['users.*', 'roles.*', 'org.*', 'settings.*', 'automation.*', 'audit.view', 'employees.view', 'employees.create', 'employees.edit', 'kb.*', 'approvals.view'],
  },
  {
    key: 'it', name: 'IT', homeDashboard: 'it',
    description: 'Internal infrastructure: assets, software licenses, domains, hosting and system access.',
    grants: ['assets.*', 'software.*', 'infrastructure.*', 'access.*', 'employees.view', 'kb.create', 'kb.edit@own'],
  },
  {
    key: 'support', name: 'Support', homeDashboard: 'support',
    description: 'Client support and maintenance: tickets, SLAs and maintenance plans.',
    grants: [
      'tickets.*', 'maintenance.*', 'clients.view', 'companies.view', 'projects.view', 'tasks.view', 'tasks.create',
      'bugs.view', 'bugs.create', 'reports.support', 'kb.create', 'kb.edit@own',
    ],
  },
];

/** Expands grant strings into concrete {permission, scope} pairs (highest scope wins on duplicates). */
export function expandGrants(grants: string[]): Map<string, Scope> {
  const out = new Map<string, Scope>();
  const rank = { own: 1, team: 2, all: 3 } as const;
  for (const g of grants) {
    const [perm, scopeRaw] = g.split('@');
    const scope = (scopeRaw ?? 'all') as Scope;
    const [group, action] = perm.split('.');
    const def = PERMISSION_GROUPS[group as keyof typeof PERMISSION_GROUPS];
    if (!def) throw new Error(`Unknown permission group in role seed: ${g}`);
    const actions: readonly string[] = action === '*' ? def.actions : [action];
    for (const a of actions) {
      if (!def.actions.includes(a as never)) throw new Error(`Unknown permission in role seed: ${g}`);
      const key = `${group}.${a}`;
      const prev = out.get(key);
      if (!prev || rank[scope] > rank[prev]) out.set(key, scope);
    }
  }
  return out;
}
