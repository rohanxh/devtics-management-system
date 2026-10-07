import { RULE_SEEDS } from '../db/seed-system.ts';

/**
 * System automation rules (seeded once, then editable in Admin › Automation).
 * Each rule: event type + payload conditions → ordered list of named actions.
 */
RULE_SEEDS.push(
  {
    key: 'employees.assigned.notify', name: 'Notify on assignment', description: 'Generic assignment notification.',
    eventType: 'employees.assigned', actions: [{ action: 'notify_assignee' }],
  },
);
