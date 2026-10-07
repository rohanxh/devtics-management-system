import { RULE_SEEDS } from '../db/seed-system.ts';

/**
 * System automation rules (seeded once, then editable in Admin › Automation).
 * Each rule: event type + payload conditions → ordered list of named actions.
 */
const assign = (resource: string, label: string) => ({
  key: `${resource}.assigned.notify`, name: `Notify on ${label} assignment`, description: `Tell the person a ${label} was assigned to.`,
  eventType: `${resource}.assigned`, actions: [{ action: 'notify_assignee', params: { title: `${label[0].toUpperCase()}${label.slice(1)} assigned to you: {title}` } }],
});

RULE_SEEDS.push(
  assign('leads', 'lead'),
  assign('opportunities', 'deal'),
  assign('follow_ups', 'follow-up'),
  assign('tasks', 'task'),
  assign('projects', 'project'),
  assign('project_risks', 'risk'),
  assign('clients', 'client account'),
  {
    key: 'project_members.added', name: 'Notify people added to a project', description: 'Team members hear when they join a project.',
    eventType: 'project_members.assigned', actions: [{ action: 'notify_assignee', params: { title: 'You were added to a project team' } }],
  },
  {
    key: 'sales.won_deal_onboarding', name: 'Won deal → project onboarding',
    description: 'Creates the client and project, links contracts and starts the BD → PM → CTO → Development onboarding.',
    eventType: 'opportunities.stage_changed', conditions: { to: 'won' }, actions: [{ action: 'sales.onboard_won_deal' }],
  },
  {
    key: 'projects.enter_qa', name: 'Project enters QA', description: 'Sets status “In QA”, notifies QA and the PM, creates the QA cycle task.',
    eventType: 'projects.stage_changed', conditions: { to: 'qa' }, actions: [{ action: 'projects.enter_qa' }],
  },
  {
    key: 'projects.delayed.alert', name: 'Delayed project alert', description: 'Notify the PM and CTO when a project becomes delayed.',
    eventType: 'projects.status_changed', conditions: { to: 'delayed' },
    actions: [
      { action: 'notify_record_users', params: { fields: ['pmId'], kind: 'escalation', title: 'Project delayed: {code} {name}' } },
      { action: 'notify_roles', params: { roles: ['cto'], kind: 'escalation', title: 'Project delayed: {title}' } },
    ],
  },
  {
    key: 'projects.at_risk.alert', name: 'At-risk project alert', description: 'Notify the CTO when a project is marked at risk.',
    eventType: 'projects.status_changed', conditions: { to: 'at_risk' },
    actions: [{ action: 'notify_roles', params: { roles: ['cto'], kind: 'escalation', title: 'Project at risk: {title}' } }],
  },
  {
    key: 'tasks.ready_for_qa', name: 'Task ready for QA', description: 'Notify QA when a task moves to QA.',
    eventType: 'tasks.status_changed', conditions: { to: 'qa' },
    actions: [{ action: 'notify_roles', params: { roles: ['qa'], title: 'Ready for QA: {title}' } }],
  },
  {
    key: 'tasks.qa_rejected', name: 'Task rejected by QA', description: 'Tell the assignee when QA sends a task back.',
    eventType: 'tasks.status_changed', conditions: { from: 'qa', to: 'in_progress' },
    actions: [{ action: 'notify_record_users', params: { fields: ['assigneeId'], title: 'QA sent back: {number} {title}' } }],
  },
  {
    key: 'tasks.completed.notify_reporter', name: 'Task completed', description: 'Tell the reporter when their task is done.',
    eventType: 'tasks.status_changed', conditions: { to: 'done' },
    actions: [{ action: 'notify_record_users', params: { fields: ['reporterId'], title: 'Completed: {number} {title}' } }],
  },
  {
    key: 'project_updates.escalation', name: 'Escalation raised', description: 'Notify the escalation target role and the PM.',
    eventType: 'project_updates.created', conditions: { kind: 'escalation' },
    actions: [{ action: 'escalation.notify' }],
  },
  {
    key: 'clients.at_risk.alert', name: 'Client at risk', description: 'Notify the account manager and leadership when a client becomes at risk.',
    eventType: 'clients.health_changed', conditions: { to: ['at_risk', 'attention_required'] },
    actions: [
      { action: 'notify_record_users', params: { fields: ['accountManagerId'], kind: 'alert', title: 'Client health: {name} needs attention' } },
      { action: 'notify_roles', params: { roles: ['ceo'], kind: 'alert', title: 'Client health changed: {title} → {to}' } },
    ],
  },
  {
    key: 'change_requests.approved.notify', name: 'Change request decided', description: 'Tell the PM when a change request is approved or rejected.',
    eventType: 'change_requests.status_changed', conditions: { to: ['approved', 'rejected'] },
    actions: [{ action: 'notify_record_users', params: { fields: ['createdBy'], title: 'Change request {to}: {title}' } }],
  },
);

// ── Engineering & QA ──
RULE_SEEDS.push(
  assign('bugs', 'bug'),
  assign('qa_runs', 'QA run'),
  assign('tech_debt', 'tech debt item'),
  {
    key: 'pull_requests.review_requested', name: 'Code review requested', description: 'Tell the reviewer a pull request needs review.',
    eventType: 'pull_requests.assigned', actions: [{ action: 'notify_assignee', params: { title: 'Code review requested: {title}' } }],
  },
  {
    key: 'pull_requests.reviewed', name: 'Code review completed', description: 'Tell the author when a review approves or requests changes.',
    eventType: 'pull_requests.status_changed', conditions: { to: ['approved', 'changes_requested'] },
    actions: [{ action: 'notify_record_users', params: { fields: ['authorId'], title: 'Review {to}: {title}' } }],
  },
  {
    key: 'bugs.critical.alert', name: 'Critical bug reported', description: 'Alert the CTO and the project manager about critical bugs.',
    eventType: 'bugs.created', conditions: { severity: 'critical' },
    actions: [{ action: 'notify_project_team', params: { who: ['pm', 'tech_lead'], roles: ['cto'], kind: 'alert', title: 'Critical bug on {code}: {title}' } }],
  },
  {
    key: 'bugs.fixed.retest', name: 'Bug fixed → retest', description: 'Tell the reporter (QA) a bug is ready to retest.',
    eventType: 'bugs.status_changed', conditions: { to: 'fixed' },
    actions: [{ action: 'notify_record_users', params: { fields: ['reportedById'], title: 'Fixed, please retest: {number} {title}' } }],
  },
  {
    key: 'bugs.reopened', name: 'Bug reopened', description: 'Tell the assignee when QA reopens a bug.',
    eventType: 'bugs.status_changed', conditions: { to: 'reopened' },
    actions: [{ action: 'notify_record_users', params: { fields: ['assigneeId'], title: 'Reopened by QA: {number} {title}' } }],
  },
  {
    key: 'deployments.failed', name: 'Deployment failed', description: 'Alert the CTO and project manager when a deployment fails.',
    eventType: 'deployments.status_changed', conditions: { to: ['failed', 'rolled_back'] },
    actions: [{ action: 'notify_project_team', params: { who: ['pm', 'tech_lead'], roles: ['cto'], kind: 'alert', title: 'Deployment {to} on {code}: {title}' } }],
  },
  {
    key: 'qa.approved.launch', name: 'QA approved → launch enabled', description: 'Tell the PM and tech lead the project passed QA and can launch.',
    eventType: 'qa.approved', actions: [{ action: 'notify_project_team', params: { who: ['pm', 'tech_lead'], title: 'QA signed off {code} — ready for launch' } }],
  },
  {
    key: 'project.launched', name: 'Project launched', description: 'Announce launches to leadership and support.',
    eventType: 'project.launched', actions: [{ action: 'notify_roles', params: { roles: ['ceo', 'support'], title: 'Launched: {title}' } }],
  },
);

// ── Finance ──
RULE_SEEDS.push(
  {
    key: 'invoices.overdue.alert', name: 'Invoice overdue', description: 'Notify Finance and the client account manager when an invoice becomes overdue (also lowers client health).',
    eventType: 'invoices.status_changed', conditions: { to: 'overdue' },
    actions: [{ action: 'notify_company_manager', params: { roles: ['finance'], title: 'Invoice overdue: {title} ({client})' } }],
  },
  {
    key: 'invoices.paid.notify', name: 'Invoice paid', description: 'Tell the account manager when a client pays in full.',
    eventType: 'invoices.status_changed', conditions: { to: 'paid' },
    actions: [{ action: 'notify_company_manager', params: { kind: 'status', title: 'Paid in full: {title} ({client})' } }],
  },
  {
    key: 'milestones.completed.billing', name: 'Billable milestone completed', description: 'Ask Finance to invoice completed billable milestones.',
    eventType: 'milestones.status_changed', conditions: { to: 'completed' }, actions: [{ action: 'finance.milestone_billable' }],
  },
  {
    key: 'expenses.submitted.review', name: 'Expense submitted', description: 'Ask Finance to review new expenses.',
    eventType: 'expenses.created', actions: [{ action: 'notify_roles', params: { roles: ['finance'], kind: 'approval_request', title: 'Expense to review: {title}' } }],
  },
  {
    key: 'expenses.decided.notify', name: 'Expense decided', description: 'Tell the submitter when an expense is approved, rejected or paid.',
    eventType: 'expenses.status_changed', conditions: { to: ['approved', 'rejected', 'paid'] },
    actions: [{ action: 'notify_record_users', params: { fields: ['submittedById'], title: 'Expense {to}: {title}' } }],
  },
  {
    key: 'payroll_runs.created.review', name: 'Payroll ready for approval', description: 'Ask payroll approvers (CEO / Finance) to review a new payroll run.',
    eventType: 'payroll_runs.created', actions: [{ action: 'notify_roles', params: { roles: ['ceo', 'finance'], kind: 'approval_request', title: 'Payroll {title} ready for approval' } }],
  },
);

// ── HR ──
RULE_SEEDS.push(
  assign('performance_reviews', 'performance review'),
  assign('interviews', 'interview'),
  assign('goals', 'goal'),
  assign('initiatives', 'initiative'),
  {
    key: 'applications.hired', name: 'Candidate hired → employee onboarding', description: 'Create the employee record and notify HR, IT and Admin to onboard.',
    eventType: 'applications.stage_changed', conditions: { to: 'hired' }, actions: [{ action: 'hr.hire_candidate' }],
  },
  {
    key: 'leave_requests.decided', name: 'Leave decided', description: 'Tell the employee when their leave is approved or rejected.',
    eventType: 'leave_requests.status_changed', conditions: { to: ['approved', 'rejected'] },
    actions: [{ action: 'notify_employee', params: { title: 'Your leave was {to}' } }],
  },
  {
    key: 'employee.hired.it_access', name: 'New hire → IT access', description: 'Ask IT to prepare accounts and equipment for a new hire.',
    eventType: 'employee.hired', actions: [{ action: 'notify_roles', params: { roles: ['it'], title: 'Prepare accounts & equipment for {title}' } }],
  },
);

// ── IT ──
RULE_SEEDS.push(
  {
    key: 'employees.left.offboarding', name: 'Employee left → offboarding', description: 'Tell IT and HR which access to revoke and which devices to recover.',
    eventType: 'employees.status_changed', conditions: { to: ['terminated', 'resigned'] }, actions: [{ action: 'it.offboarding' }],
  },
);

// ── Marketing ──
RULE_SEEDS.push(
  assign('content_items', 'content piece'),
  assign('campaigns', 'campaign'),
  assign('seo_keywords', 'keyword'),
  {
    key: 'leads.created.marketing', name: 'New lead → BD', description: 'Tell Business Development about new leads (e.g. from campaigns or the website).',
    eventType: 'leads.created', actions: [{ action: 'notify_roles', params: { roles: ['bd'], title: 'New lead: {title}' } }],
  },
);

// ── Support ──
RULE_SEEDS.push(
  assign('tickets', 'ticket'),
  {
    key: 'tickets.urgent.alert', name: 'Urgent ticket', description: 'Alert Support and the account manager when an urgent ticket arrives.',
    eventType: 'tickets.created', conditions: { priority: 'urgent' },
    actions: [{ action: 'notify_company_manager', params: { roles: ['support', 'cto'], kind: 'escalation', title: 'Urgent ticket from {client}: {title}' } }],
  },
  {
    key: 'tickets.new.support', name: 'New ticket → Support', description: 'Tell Support about new tickets.',
    eventType: 'tickets.created', actions: [{ action: 'notify_roles', params: { roles: ['support'], title: 'New ticket: {title}' } }],
  },
  {
    key: 'tickets.sync.tasks', name: 'Task progress updates ticket', description: 'Tickets move to QA when the linked task reaches QA/done.',
    eventType: 'tasks.status_changed', conditions: { to: ['qa', 'done'] }, actions: [{ action: 'support.sync_from_work' }],
  },
  {
    key: 'tickets.sync.bugs', name: 'Bug progress updates ticket', description: 'Tickets move to QA / resolved as the linked bug is retested and verified.',
    eventType: 'bugs.status_changed', conditions: { to: ['ready_for_retest', 'verified', 'closed'] }, actions: [{ action: 'support.sync_from_work' }],
  },
  {
    key: 'tickets.resolved.notify', name: 'Ticket resolved', description: 'Tell the account manager a client ticket was resolved.',
    eventType: 'tickets.status_changed', conditions: { to: 'resolved' },
    actions: [{ action: 'notify_company_manager', params: { kind: 'status', title: 'Resolved for {client}: {title}' } }],
  },
);
