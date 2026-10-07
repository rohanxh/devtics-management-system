import type { PgColumn } from 'drizzle-orm/pg-core';
import { PERMISSION_GROUPS } from '../rbac/catalog.ts';
import type { ResourceAction, ResourceDef } from './types.ts';

const registry = new Map<string, ResourceDef>();

export function defineResource(def: ResourceDef): ResourceDef {
  const t = def.table as any;
  if (!t.id) throw new Error(`Resource ${def.key}: table needs an id column`);
  for (const k of Object.keys(def.fields)) {
    if (!t[k]) throw new Error(`Resource ${def.key}: field "${k}" is not a column of the table`);
  }
  if (!t[def.titleField]) throw new Error(`Resource ${def.key}: titleField "${def.titleField}" missing`);
  if (!(def.perm in PERMISSION_GROUPS)) throw new Error(`Resource ${def.key}: unknown permission group ${def.perm}`);
  if (registry.has(def.key)) throw new Error(`Resource ${def.key} defined twice`);
  registry.set(def.key, def);
  return def;
}

export function getResource(key: string): ResourceDef | undefined {
  return registry.get(key);
}
export const allResources = () => [...registry.values()];

export function col(def: ResourceDef, field: string): PgColumn {
  return (def.table as any)[field];
}

/** Permission key for an action; `null` → action disabled. */
export function permFor(def: ResourceDef, action: ResourceAction): string | null {
  if (def.permissions && action in def.permissions) return def.permissions[action] ?? null;
  const actions = PERMISSION_GROUPS[def.perm as keyof typeof PERMISSION_GROUPS].actions as readonly string[];
  if (!actions.includes(action)) {
    // groups like org/roles only have view + manage
    if (action !== 'view' && actions.includes('manage')) return `${def.perm}.manage`;
    if (action === 'export') return `${def.perm}.view`;
    return null;
  }
  return `${def.perm}.${action}`;
}

export function assignPerm(def: ResourceDef): string | null {
  const actions = PERMISSION_GROUPS[def.perm as keyof typeof PERMISSION_GROUPS].actions as readonly string[];
  return actions.includes('assign') ? `${def.perm}.assign` : null;
}
