import {
  BarChart3, BookOpen, Briefcase, Building2, Bug, CalendarDays, CheckSquare, ClipboardCheck, Clock, Code2, Contact,
  CreditCard, FileSignature, FileText, FlaskConical, Gauge, GitPullRequest, Globe, HardDrive, Headphones, Home,
  KeyRound, Laptop, LayoutDashboard, LifeBuoy, ListChecks, Megaphone, Milestone, Package, Receipt, Rocket,
  ScrollText, Search, Server, Settings, Shield, ShieldCheck, Target, TrendingUp, UserPlus, Users, Wallet, Workflow,
  AlertTriangle, GitBranch, type LucideIcon, Inbox, Timer, PlaneTakeoff, Star, Banknote, Landmark, Award,
} from 'lucide-react';

export interface NavItem {
  label: string; to: string; icon: LucideIcon; resource?: string; perm?: string; anyPerm?: string[];
  /** Self-service resources: hidden from team sections when the user can only see their own records (they appear under “Me”). */
  teamOnly?: boolean;
  /** Shown only when the user's access to the resource is own-scope (the “Me” section). */
  ownOnly?: boolean;
}
export interface NavGroup { label: string; items: NavItem[] }

const r = (label: string, resource: string, icon: LucideIcon, extra: Partial<NavItem> = {}): NavItem => ({ label, to: `/r/${resource}`, icon, resource, ...extra });
const me = (label: string, resource: string, icon: LucideIcon) => r(label, resource, icon, { ownOnly: true });

export const NAV: NavGroup[] = [
  {
    label: '', items: [
      { label: 'Dashboard', to: '/', icon: Home },
      { label: 'My work', to: '/my-work', icon: CheckSquare, resource: 'tasks' },
      { label: 'Approvals', to: '/approvals', icon: ShieldCheck },
      { label: 'Inbox', to: '/notifications', icon: Inbox },
    ],
  },
  {
    label: 'Me', items: [
      me('My leave', 'leave_requests', PlaneTakeoff),
      me('My payslips', 'payroll_items', Banknote),
      me('My expenses', 'expenses', Wallet),
      me('My equipment', 'assets', Laptop),
      me('My reviews', 'performance_reviews', Star),
      me('My time', 'time_entries', Timer),
    ],
  },
  {
    label: 'Strategy', items: [
      { label: 'Reports', to: '/reports', icon: BarChart3, anyPerm: ['reports.executive', 'reports.finance', 'reports.projects', 'reports.sales', 'reports.hr', 'reports.technical', 'reports.marketing', 'reports.support'] },
      r('Goals & OKRs', 'goals', Target),
      r('KPIs', 'kpis', Gauge),
      r('Initiatives', 'initiatives', Rocket),
      r('Company risks', 'company_risks', AlertTriangle),
    ],
  },
  {
    label: 'Sales & CRM', items: [
      r('Leads', 'leads', UserPlus),
      r('Opportunities', 'opportunities', TrendingUp),
      r('Clients', 'clients', Briefcase),
      r('Companies', 'companies', Building2),
      r('Contacts', 'contacts', Contact),
      r('Quotes', 'quotes', FileText),
      r('Proposals', 'proposals', ScrollText),
      r('Contracts & SOWs', 'contracts', FileSignature),
      r('Sales targets', 'sales_targets', Award),
    ],
  },
  {
    label: 'Delivery', items: [
      r('Projects', 'projects', LayoutDashboard),
      r('Tasks', 'tasks', ListChecks),
      r('Milestones', 'milestones', Milestone),
      r('Change requests', 'change_requests', Workflow),
      r('Risks & issues', 'project_risks', AlertTriangle),
      r('Time entries', 'time_entries', Timer, { teamOnly: true }),
    ],
  },
  {
    label: 'Engineering', items: [
      r('Bugs', 'bugs', Bug),
      r('QA runs', 'qa_runs', FlaskConical),
      r('Test cases', 'test_cases', ClipboardCheck),
      r('QA templates', 'qa_templates', ListChecks),
      r('Pull requests', 'pull_requests', GitPullRequest),
      r('Deployments', 'deployments', Rocket),
      r('Repositories', 'repositories', GitBranch),
      r('Environments', 'environments', Server),
      r('Technical reviews', 'tech_reviews', Code2),
      r('Tech debt', 'tech_debt', AlertTriangle),
    ],
  },
  {
    label: 'Finance', items: [
      r('Invoices', 'invoices', Receipt),
      r('Payments', 'payments', CreditCard),
      r('Recurring billing', 'recurring_billing', CalendarDays),
      r('Expenses', 'expenses', Wallet, { teamOnly: true }),
      r('Payroll runs', 'payroll_runs', Banknote, { teamOnly: true }),
      r('Compensation', 'compensation', Landmark, { teamOnly: true }),
      r('Bonuses & deductions', 'employee_adjustments', Banknote, { teamOnly: true }),
    ],
  },
  {
    label: 'People', items: [
      r('Employees', 'employees', Users, { teamOnly: true }),
      { label: 'Attendance', to: '/attendance', icon: Clock, resource: 'attendance' },
      r('Leave', 'leave_requests', PlaneTakeoff, { teamOnly: true }),
      r('Performance reviews', 'performance_reviews', Star, { teamOnly: true }),
      r('Training', 'trainings', BookOpen, { teamOnly: true }),
      r('Job openings', 'job_openings', Briefcase, { teamOnly: true }),
      r('Candidates', 'applications', UserPlus, { teamOnly: true }),
    ],
  },
  {
    label: 'Support', items: [
      r('Tickets', 'tickets', LifeBuoy),
      r('Maintenance plans', 'maintenance_plans', Headphones),
      r('SLA policies', 'sla_policies', Timer),
    ],
  },
  {
    label: 'IT', items: [
      r('Assets', 'assets', Laptop, { teamOnly: true }),
      r('Software & licenses', 'subscriptions', Package, { teamOnly: true }),
      r('Infrastructure', 'infra_resources', HardDrive),
      r('Access records', 'access_grants', KeyRound, { teamOnly: true }),
    ],
  },
  {
    label: 'Marketing', items: [
      r('Campaigns', 'campaigns', Megaphone),
      r('Keywords', 'seo_keywords', Search),
      r('Content pipeline', 'content_items', FileText),
      r('SEO audits', 'seo_audits', Globe),
      r('Backlinks', 'backlinks', Globe),
    ],
  },
  {
    label: 'Knowledge', items: [
      { label: 'Knowledge base', to: '/kb', icon: BookOpen, perm: 'kb.view' },
    ],
  },
  {
    label: 'Admin', items: [
      { label: 'Users', to: '/admin/users', icon: Users, perm: 'users.view' },
      { label: 'Roles & permissions', to: '/admin/roles', icon: Shield, perm: 'roles.view' },
      r('Departments', 'departments', Building2, { perm: 'org.manage' }),
      r('Designations', 'designations', Award, { perm: 'org.manage' }),
      r('Locations', 'locations', Globe, { perm: 'org.manage' }),
      r('Working hours', 'work_schedules', Clock, { perm: 'org.manage' }),
      r('Holidays', 'holidays', CalendarDays, { perm: 'org.manage' }),
      { label: 'Pipelines', to: '/r/pipeline_stages', icon: Workflow, perm: 'settings.manage' },
      { label: 'Automation', to: '/admin/automation', icon: Workflow, perm: 'automation.view' },
      { label: 'Audit log', to: '/admin/audit', icon: ScrollText, perm: 'audit.view' },
      { label: 'Settings', to: '/admin/settings', icon: Settings, perm: 'settings.manage' },
    ],
  },
];
