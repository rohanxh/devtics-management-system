import { eq, or, sql } from 'drizzle-orm';
import {
  departments, designations, employees, holidays, locations, pipelineStages, users, workSchedules,
} from '../../db/schema/index.ts';
import { forbidden } from '../../core/errors.ts';
import { defineResource } from '../registry.ts';

const SENSITIVE = 'employees_sensitive.view';

defineResource({
  key: 'users', table: users, label: 'User', plural: 'Users', module: 'admin', perm: 'users',
  titleField: 'name', directory: true, defaultSort: 'name',
  // Creation (temporary password + roles) and role changes go through /api/admin/users.
  permissions: { create: null, delete: null },
  description: 'Login accounts. Access is granted through roles.',
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    email: { type: 'email', label: 'Email', required: true, list: true, search: true },
    status: { type: 'enum', label: 'Status', options: ['active', 'disabled'], list: true, filter: true },
    lastLoginAt: { type: 'datetime', label: 'Last login', readonly: true, list: true },
    mustChangePassword: { type: 'bool', label: 'Must change password', readonly: true },
  },
  hooks: {
    beforeUpdate(c, data, prev) {
      if (prev.id === c.actor.userId && data.status === 'disabled') throw forbidden('You cannot disable your own account');
    },
  },
});

defineResource({
  key: 'departments', table: departments, label: 'Department', plural: 'Departments', module: 'admin', perm: 'org',
  titleField: 'name', directory: true, defaultSort: 'name',
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    code: { type: 'text', label: 'Code', required: true, list: true, max: 20 },
    parentId: { type: 'ref', ref: 'departments', label: 'Parent department', list: true },
    headUserId: { type: 'ref', ref: 'users', label: 'Head of department', list: true },
    description: { type: 'textarea', label: 'Description' },
  },
  children: [{ resource: 'employees', field: 'departmentId' }, { resource: 'designations', field: 'departmentId' }],
});

defineResource({
  key: 'designations', table: designations, label: 'Designation', plural: 'Designations', module: 'admin', perm: 'org',
  titleField: 'title', directory: true, defaultSort: 'title',
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    departmentId: { type: 'ref', ref: 'departments', label: 'Department', list: true, filter: true },
    level: { type: 'int', label: 'Level', list: true, min: 1, max: 20, help: '1 = entry level' },
  },
});

defineResource({
  key: 'locations', table: locations, label: 'Location', plural: 'Locations', module: 'admin', perm: 'org',
  titleField: 'name', directory: true, defaultSort: 'name',
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    address: { type: 'textarea', label: 'Address' },
    timezone: { type: 'text', label: 'Time zone', required: true, list: true, default: 'Asia/Karachi' },
  },
});

defineResource({
  key: 'work_schedules', table: workSchedules, label: 'Working hours', plural: 'Working hours', module: 'admin', perm: 'org',
  titleField: 'name', directory: true, defaultSort: 'name',
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true },
    startTime: { type: 'time', label: 'Start time', required: true, list: true },
    endTime: { type: 'time', label: 'End time', required: true, list: true },
    workdays: { type: 'tags', label: 'Workdays (1=Mon … 7=Sun)', required: true, list: true, readonly: true },
    graceMinutes: { type: 'int', label: 'Late grace (minutes)', min: 0, max: 240, list: true, default: 15 },
  },
});

defineResource({
  key: 'holidays', table: holidays, label: 'Holiday', plural: 'Holidays', module: 'admin', perm: 'org',
  titleField: 'name', directory: true, defaultSort: 'date',
  fields: {
    date: { type: 'date', label: 'Date', required: true, list: true, filter: true },
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    locationId: { type: 'ref', ref: 'locations', label: 'Location (blank = all)', list: true, filter: true },
  },
});

defineResource({
  key: 'pipeline_stages', table: pipelineStages, label: 'Pipeline stage', plural: 'Pipeline stages', module: 'admin', perm: 'settings',
  permissions: { view: 'org.view' },
  titleField: 'name', directory: true, defaultSort: 'pipeline,sortOrder',
  description: 'Configurable stages for the project lifecycle, sales pipeline, content pipeline, recruitment and more.',
  fields: {
    pipeline: { type: 'enum', label: 'Pipeline', required: true, createOnly: true, list: true, filter: true, options: ['project', 'sales', 'content', 'recruitment'] },
    key: { type: 'text', label: 'Key', required: true, createOnly: true, list: true, max: 40 },
    name: { type: 'text', label: 'Name', required: true, list: true },
    sortOrder: { type: 'int', label: 'Order', required: true, list: true },
    color: { type: 'enum', label: 'Color', options: ['slate', 'blue', 'indigo', 'violet', 'amber', 'orange', 'emerald', 'green', 'red', 'rose', 'cyan', 'teal'], list: true, default: 'slate' },
    isTerminal: { type: 'bool', label: 'Terminal stage', list: true, default: false },
    outcome: { type: 'enum', label: 'Outcome', options: ['won', 'lost', 'hired', 'rejected', 'done'], list: true },
  },
});

// Team = direct reports. Own = the actor's own employee record.
const ownEmployee = (a: { userId: string }) => eq(employees.userId, a.userId);

defineResource({
  key: 'employees', table: employees, label: 'Employee', plural: 'Employees', module: 'people', perm: 'employees',
  titleField: 'firstName', titleSql: sql`${employees.firstName} || ' ' || ${employees.lastName}`, defaultSort: 'firstName',
  formatTitle: (r) => `${r.firstName} ${r.lastName}`,
  scopes: {
    own: ownEmployee,
    team: (a) => or(ownEmployee(a), sql`${employees.managerId} = (select e.id from employees e where e.user_id = ${a.userId})`)!,
  },
  collab: { comments: true, files: true },
  fields: {
    employeeCode: { type: 'text', label: 'Employee ID', required: true, list: true, search: true, max: 20, group: 'Employment' },
    firstName: { type: 'text', label: 'First name', required: true, list: true, search: true, group: 'Profile' },
    lastName: { type: 'text', label: 'Last name', required: true, list: true, search: true, group: 'Profile' },
    workEmail: { type: 'email', label: 'Work email', list: true, search: true, group: 'Profile' },
    phone: { type: 'phone', label: 'Work phone', group: 'Profile' },
    userId: { type: 'ref', ref: 'users', label: 'Login account', group: 'Profile', writePermission: 'employees.create' },
    departmentId: { type: 'ref', ref: 'departments', label: 'Department', list: true, filter: true, group: 'Employment' },
    designationId: { type: 'ref', ref: 'designations', label: 'Designation', list: true, filter: true, group: 'Employment' },
    managerId: { type: 'ref', ref: 'employees', label: 'Manager', filter: true, group: 'Employment' },
    locationId: { type: 'ref', ref: 'locations', label: 'Location', filter: true, group: 'Employment' },
    workScheduleId: { type: 'ref', ref: 'work_schedules', label: 'Working hours', group: 'Employment' },
    employmentType: { type: 'enum', label: 'Employment type', options: ['full_time', 'part_time', 'contract', 'intern'], filter: true, default: 'full_time', group: 'Employment' },
    employmentStatus: { type: 'enum', label: 'Status', options: ['probation', 'active', 'notice', 'terminated', 'resigned'], list: true, filter: true, default: 'probation', group: 'Employment' },
    joinDate: { type: 'date', label: 'Join date', required: true, list: true, group: 'Employment' },
    probationEndDate: { type: 'date', label: 'Probation ends', group: 'Employment' },
    exitDate: { type: 'date', label: 'Exit date', group: 'Employment' },
    personalEmail: { type: 'email', label: 'Personal email', readPermission: SENSITIVE, writePermission: 'employees_sensitive.edit', group: 'Private (HR)' },
    dateOfBirth: { type: 'date', label: 'Date of birth', readPermission: SENSITIVE, writePermission: 'employees_sensitive.edit', group: 'Private (HR)' },
    address: { type: 'textarea', label: 'Home address', readPermission: SENSITIVE, writePermission: 'employees_sensitive.edit', group: 'Private (HR)' },
    nationalIdLast4: { type: 'text', label: 'National ID (last 4)', max: 4, readPermission: SENSITIVE, writePermission: 'employees_sensitive.edit', group: 'Private (HR)' },
  },
  status: {
    field: 'employmentStatus',
    transitions: {
      probation: ['active', 'terminated', 'resigned', 'notice'],
      active: ['notice', 'terminated', 'resigned'],
      notice: ['active', 'terminated', 'resigned'],
      terminated: [], resigned: [],
    },
  },
});

