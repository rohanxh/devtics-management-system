import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DB } from '../db/client.ts';
import type { Actor } from '../rbac/actor.ts';

export type FieldType =
  | 'text' | 'textarea' | 'markdown' | 'email' | 'url' | 'phone'
  | 'int' | 'decimal' | 'money' | 'percent' | 'hours'
  | 'bool' | 'date' | 'datetime' | 'time'
  | 'enum' | 'ref' | 'stage' | 'tags';

export interface FieldDef {
  type: FieldType;
  label: string;
  required?: boolean;
  /** Never writable through the generic API (computed, or managed by a workflow/service). */
  readonly?: boolean;
  /** Writable on create only. */
  createOnly?: boolean;
  options?: readonly string[];
  /** Target resource key for `ref` fields. */
  ref?: string;
  /** Pipeline key for `stage` fields. */
  pipeline?: string;
  /** Shown as a column in list views by default. */
  list?: boolean;
  /** Offered as a filter in list views. */
  filter?: boolean;
  /** Included in free-text search. */
  search?: boolean;
  /** Field-level restriction: permission required to see this field. */
  readPermission?: string;
  /** Permission required to write this field (defaults to readPermission). */
  writePermission?: string;
  /** Rows on which a limited-scope readPermission applies (defaults to the resource scope rules). */
  readScope?: (a: Actor) => SQL;
  default?: unknown | ((actor: Actor) => unknown);
  min?: number;
  max?: number;
  help?: string;
  /** Hidden from generic forms (still readable). */
  hidden?: boolean;
  /** Form section heading. */
  group?: string;
}

export type Row = Record<string, any> & { id: string };

export interface HookCtx {
  tx: DB;
  actor: Actor;
  requestId: string;
}

export interface ResourceDef {
  key: string;
  table: PgTable;
  label: string;
  plural: string;
  /** Navigation group / module. */
  module: string;
  /** Permission group (see rbac/catalog.ts). */
  perm: string;
  /** Override individual action permissions; `null` disables the action through the generic API. */
  permissions?: Partial<Record<'view' | 'create' | 'edit' | 'delete' | 'export', string | null>>;
  /** Column used as the human-readable title. */
  titleField: string;
  /** Optional SQL expression for the title (e.g. first || ' ' || last). */
  titleSql?: SQL;
  /** Builds the display title from a row (keep consistent with titleSql). */
  formatTitle?: (row: Row) => string;
  description?: string;
  fields: Record<string, FieldDef>;
  /** Record-level scope rules applied when the actor's grant scope is `own` / `team`. */
  scopes?: { own?: (a: Actor) => SQL; team?: (a: Actor) => SQL };
  /** Any authenticated user may look up id + title (pickers, labels). */
  directory?: boolean;
  /** Fixed filter: this resource is a view over a subset of the table (e.g. clients = companies with client lifecycle). */
  baseWhere?: SQL;
  /** Soft-delete column name (timestamp). */
  softDelete?: string;
  defaultSort?: string;
  /** State machine for the status field. Missing `transitions` → any option allowed. */
  status?: { field: string; transitions?: Record<string, string[]> };
  /** User-reference fields that represent assignment (notifications, “mine” filter, assign permission). */
  assignees?: string[];
  numbering?: { field: string; key: string; prefix: string; pad?: number };
  /** Row fields copied into every domain event payload (usable in automation conditions). */
  eventFields?: string[];
  /** Related lists shown on the detail page. */
  children?: { resource: string; field: string; label?: string }[];
  /** Field to group the Kanban board by (enum or stage). */
  board?: string;
  /** Attachments in these categories are only visible to holders of `permission` (or on the record's own-scope rows). */
  privateFiles?: { categories: string[]; permission: string };
  /** Collaboration features on the detail page. */
  collab?: { comments?: boolean; files?: boolean };
  hooks?: {
    beforeCreate?(c: HookCtx, data: Record<string, any>): Promise<void> | void;
    afterCreate?(c: HookCtx, row: Row): Promise<void> | void;
    beforeUpdate?(c: HookCtx, data: Record<string, any>, prev: Row): Promise<void> | void;
    afterUpdate?(c: HookCtx, row: Row, prev: Row): Promise<void> | void;
    beforeDelete?(c: HookCtx, row: Row): Promise<void> | void;
    afterDelete?(c: HookCtx, row: Row): Promise<void> | void;
  };
}

export type ResourceAction = 'view' | 'create' | 'edit' | 'delete' | 'export';
export type AnyColumn = PgColumn;
