/**
 * The permission catalog. Every permission key in role_permissions must exist here.
 * Key format: `<area>.<action>`. Scope (own | team | all) is stored per grant and is
 * interpreted by each resource's record-level scope rules (see resources/defs).
 */
export const PERMISSION_GROUPS = {
  // Administration
  users: { label: 'Users', actions: ['view', 'create', 'edit', 'delete'] },
  roles: { label: 'Roles & permissions', actions: ['view', 'manage'] },
  org: { label: 'Org structure (departments, designations, locations, schedules, holidays)', actions: ['view', 'manage'] },
  settings: { label: 'System settings', actions: ['manage'] },
  automation: { label: 'Automation rules', actions: ['view', 'manage'] },
  audit: { label: 'Audit log', actions: ['view'] },

  // People
  employees: { label: 'Employees', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  'employees_sensitive': { label: 'Employee private data (DOB, address, ID, emergency contacts)', actions: ['view', 'edit'] },
  compensation: { label: 'Salary & compensation', actions: ['view', 'edit'] },

  // CRM & sales
  companies: { label: 'Companies & contacts', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  leads: { label: 'Leads', actions: ['view', 'create', 'edit', 'delete', 'export', 'assign'] },
  opportunities: { label: 'Opportunities / deals', actions: ['view', 'create', 'edit', 'delete', 'export', 'assign'] },
  sales_docs: { label: 'Quotes, proposals, contracts & SOWs', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
  sales_targets: { label: 'Sales targets & commission', actions: ['view', 'manage'] },
  clients: { label: 'Clients', actions: ['view', 'create', 'edit', 'delete', 'export'] },

  // Delivery
  projects: { label: 'Projects', actions: ['view', 'create', 'edit', 'delete', 'export', 'assign', 'approve'] },
  project_finance: { label: 'Project budget & profitability', actions: ['view'] },
  tasks: { label: 'Tasks', actions: ['view', 'create', 'edit', 'delete', 'assign'] },
  time: { label: 'Time entries', actions: ['view', 'create', 'edit', 'delete'] },
  dev: { label: 'Repositories, environments, PRs & deployments', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
  bugs: { label: 'Bugs', actions: ['view', 'create', 'edit', 'delete', 'assign'] },
  qa: { label: 'QA test cases, runs & templates', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
  tech: { label: 'Technical reviews, tech debt & standards', actions: ['view', 'create', 'edit', 'approve'] },

  // Finance
  invoices: { label: 'Invoices & recurring billing', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  payments: { label: 'Payments', actions: ['view', 'create', 'edit', 'delete'] },
  expenses: { label: 'Expenses & payables', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
  payroll: { label: 'Payroll, bonuses, deductions & advances', actions: ['view', 'create', 'edit', 'approve'] },

  // HR
  attendance: { label: 'Attendance', actions: ['view', 'create', 'edit'] },
  leave: { label: 'Leave', actions: ['view', 'create', 'edit', 'approve'] },
  performance: { label: 'Performance reviews & training', actions: ['view', 'create', 'edit'] },
  recruitment: { label: 'Recruitment', actions: ['view', 'create', 'edit', 'delete'] },

  // Strategy
  goals: { label: 'Goals, KPIs, initiatives & company risks', actions: ['view', 'create', 'edit', 'delete'] },

  // IT
  assets: { label: 'IT assets', actions: ['view', 'create', 'edit', 'delete'] },
  software: { label: 'SaaS subscriptions & licenses', actions: ['view', 'create', 'edit', 'delete'] },
  infrastructure: { label: 'Domains, hosting, servers & cloud', actions: ['view', 'create', 'edit', 'delete'] },
  access: { label: 'System access records', actions: ['view', 'create', 'edit', 'delete'] },

  // Marketing
  marketing: { label: 'Campaigns, SEO & content', actions: ['view', 'create', 'edit', 'delete'] },

  // Support
  tickets: { label: 'Support tickets', actions: ['view', 'create', 'edit', 'delete', 'assign'] },
  maintenance: { label: 'Maintenance plans & SLAs', actions: ['view', 'create', 'edit', 'delete'] },

  // Knowledge
  kb: { label: 'Knowledge base', actions: ['view', 'create', 'edit', 'delete', 'publish'] },

  // Cross-cutting
  approvals: { label: 'Approvals (view all pending)', actions: ['view'] },
  reports: { label: 'Reports', actions: ['executive', 'technical', 'hr', 'finance', 'projects', 'sales', 'marketing', 'support'] },
} as const;

export type PermissionGroup = keyof typeof PERMISSION_GROUPS;
export type Scope = 'own' | 'team' | 'all';

export const ALL_PERMISSIONS: string[] = Object.entries(PERMISSION_GROUPS).flatMap(([g, def]) =>
  def.actions.map((a) => `${g}.${a}`),
);
const PERMISSION_SET = new Set(ALL_PERMISSIONS);
export const isPermission = (p: string) => PERMISSION_SET.has(p);

/** Granting any of these requires the granter to hold them (privilege-escalation guard). */
export const SENSITIVE_PREFIXES = ['compensation.', 'payroll.', 'employees_sensitive.', 'roles.', 'audit.', 'settings.', 'users.'];

export const SCOPE_RANK: Record<Scope, number> = { own: 1, team: 2, all: 3 };
