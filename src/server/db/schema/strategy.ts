import { pgTable, pgEnum, text, integer, date, uuid, index, numeric, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps, money } from './_helpers.ts';
import { users, departments, employees } from './core.ts';

export const goalLevel = pgEnum('goal_level', ['company', 'department', 'team', 'individual']);
export const goalKind = pgEnum('goal_kind', ['objective', 'key_result', 'revenue_target', 'growth_target']);
export const goalStatus = pgEnum('goal_status', ['not_started', 'on_track', 'at_risk', 'behind', 'achieved', 'missed']);

/** Company goals, quarterly objectives (OKRs), department and individual goals, revenue & growth targets. */
export const goals = pgTable('goals', {
  id: id(),
  title: text().notNull(),
  description: text(),
  level: goalLevel().notNull().default('company'),
  kind: goalKind().notNull().default('objective'),
  departmentId: uuid().references(() => departments.id),
  employeeId: uuid().references(() => employees.id, { onDelete: 'cascade' }),
  ownerId: uuid().references(() => users.id),
  parentGoalId: uuid().references((): AnyPgColumn => goals.id, { onDelete: 'set null' }),
  /** e.g. "2026-Q4" or "2026" */
  period: text().notNull(),
  startDate: date(),
  endDate: date(),
  unit: text(),
  startValue: numeric({ precision: 14, scale: 2 }),
  targetValue: numeric({ precision: 14, scale: 2 }),
  currentValue: numeric({ precision: 14, scale: 2 }),
  /** Optional automatic measurement (see KPI metric keys). */
  metricKey: text(),
  status: goalStatus().notNull().default('not_started'),
  ...timestamps,
}, (t) => [index('goals_level_idx').on(t.level, t.period), index('goals_parent_idx').on(t.parentGoalId)]);

export const kpiDirection = pgEnum('kpi_direction', ['higher_is_better', 'lower_is_better']);
export const kpiFrequency = pgEnum('kpi_frequency', ['weekly', 'monthly', 'quarterly']);

/** Department KPIs. KPIs with a metric key are measured automatically from system data. */
export const kpis = pgTable('kpis', {
  id: id(),
  name: text().notNull(),
  departmentId: uuid().references(() => departments.id),
  ownerId: uuid().references(() => users.id),
  unit: text(),
  direction: kpiDirection().notNull().default('higher_is_better'),
  target: numeric({ precision: 14, scale: 2 }),
  frequency: kpiFrequency().notNull().default('monthly'),
  metricKey: text(),
  description: text(),
  ...timestamps,
});

export const kpiValues = pgTable('kpi_values', {
  id: id(),
  kpiId: uuid().notNull().references(() => kpis.id, { onDelete: 'cascade' }),
  periodStart: date().notNull(),
  periodEnd: date().notNull(),
  value: numeric({ precision: 14, scale: 2 }).notNull(),
  note: text(),
  ...timestamps,
}, (t) => [uniqueIndex('kpi_values_uq').on(t.kpiId, t.periodStart)]);

export const initiativeStatus = pgEnum('initiative_status', ['proposed', 'active', 'on_hold', 'completed', 'cancelled']);

export const initiatives = pgTable('initiatives', {
  id: id(),
  title: text().notNull(),
  description: text(),
  ownerId: uuid().references(() => users.id),
  goalId: uuid().references(() => goals.id, { onDelete: 'set null' }),
  status: initiativeStatus().notNull().default('proposed'),
  startDate: date(),
  endDate: date(),
  progressPct: integer().notNull().default(0),
  budget: money(),
  ...timestamps,
});
