import {
  and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL,
} from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { activities, pipelineStages, users } from '../db/schema/index.ts';
import type { Actor } from '../rbac/actor.ts';
import { can } from '../rbac/actor.ts';
import type { Ctx } from '../core/context.ts';
import { tx as inTx } from '../core/context.ts';
import { AppError, badRequest, forbidden, invalid, notFound } from '../core/errors.ts';
import { emit } from '../core/events.ts';
import { nextNumber } from '../core/counters.ts';
import { assignPerm, col, getResource, permFor } from './registry.ts';
import type { FieldDef, HookCtx, ResourceAction, ResourceDef, Row } from './types.ts';
import { formatZodError, isUuid, objectSchema } from './validate.ts';

export function requireResource(key: string): ResourceDef {
  const def = getResource(key);
  if (!def) throw notFound('Resource');
  return def;
}

// ───────────────────────── Authorization helpers ─────────────────────────

/**
 * Record-level condition for an action. Returns:
 *  - undefined  → no restriction (scope "all")
 *  - SQL        → rows the actor may touch
 * Throws 403 if the actor lacks the permission entirely.
 */
export function scopeCondition(def: ResourceDef, actor: Actor, action: ResourceAction): SQL | undefined {
  const perm = permFor(def, action);
  if (!perm) throw forbidden(`${def.plural} cannot be ${action === 'view' ? 'viewed' : action + 'd'} here`);
  const scope = actor.perms.get(perm);
  if (!scope) throw forbidden();
  if (scope === 'all') return undefined;
  const rule = scope === 'team' ? (def.scopes?.team ?? def.scopes?.own) : def.scopes?.own;
  return rule ? rule(actor) : sql`false`;
}

export function canAction(def: ResourceDef, actor: Actor, action: ResourceAction) {
  const perm = permFor(def, action);
  return !!perm && can(actor, perm);
}

const fieldReadable = (f: FieldDef, actor: Actor) => !f.readPermission || can(actor, f.readPermission);
const fieldWritable = (f: FieldDef, actor: Actor) => {
  const p = f.writePermission ?? f.readPermission;
  return !f.readonly && (!p || can(actor, p));
};

function notDeleted(def: ResourceDef): SQL | undefined {
  return and(def.softDelete ? isNull(col(def, def.softDelete)) : undefined, def.baseWhere);
}

/** Can the actor see this record? Used by collaboration endpoints, file downloads and notifications. */
export async function isVisible(db: DB, actor: Actor, key: string, id: string): Promise<boolean> {
  const def = getResource(key);
  if (!def || !isUuid(id)) return false;
  let cond: SQL | undefined;
  try { cond = scopeCondition(def, actor, 'view'); } catch { return false; }
  const rows = await db.select({ id: col(def, 'id') }).from(def.table)
    .where(and(eq(col(def, 'id'), id), cond, notDeleted(def))).limit(1);
  return rows.length > 0;
}

export async function assertVisible(db: DB, actor: Actor, key: string, id: string) {
  if (!(await isVisible(db, actor, key, id))) throw notFound(getResource(key)?.label);
}

// ───────────────────────── Querying ─────────────────────────

export interface ListQuery { [k: string]: string | undefined }

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

function parseValue(f: FieldDef, raw: string, field: string): unknown {
  switch (f.type) {
    case 'ref': case 'stage':
      if (!isUuid(raw)) throw badRequest(`Invalid filter value for ${field}`);
      return raw;
    case 'int': case 'decimal': case 'money': case 'percent': case 'hours':
      if (Number.isNaN(Number(raw))) throw badRequest(`Invalid filter value for ${field}`);
      return raw;
    case 'bool': return raw === 'true';
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw badRequest(`Invalid date for ${field}`);
      return raw;
    case 'datetime': {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw badRequest(`Invalid date for ${field}`);
      return d;
    }
    case 'enum':
      if (!f.options?.includes(raw)) throw badRequest(`Invalid filter value for ${field}`);
      return raw;
    default: return raw;
  }
}

export function buildWhere(def: ResourceDef, actor: Actor, q: ListQuery, action: ResourceAction = 'view'): SQL | undefined {
  const conds: (SQL | undefined)[] = [scopeCondition(def, actor, action), notDeleted(def)];

  for (const [param, rawValue] of Object.entries(q)) {
    if (rawValue === undefined || rawValue === '') continue;
    const [name, op] = param.split('__');
    if (name === 'id' && op === 'in') {
      const ids = rawValue.split(',').filter(isUuid);
      conds.push(ids.length ? inArray(col(def, 'id'), ids) : sql`false`);
      continue;
    }
    const f = def.fields[name];
    if (!f || !fieldReadable(f, actor)) continue;
    const c = col(def, name);
    if (rawValue === '__null') { conds.push(isNull(c)); continue; }
    if (rawValue === '__notnull') { conds.push(isNotNull(c)); continue; }
    if (op === 'gte') conds.push(gte(c, parseValue(f, rawValue, name)));
    else if (op === 'lte') conds.push(lte(c, parseValue(f, rawValue, name)));
    else if (f.type === 'tags') conds.push(sql`${c} @> ${[rawValue]}`);
    else {
      const values = rawValue.split(',').map((v) => parseValue(f, v, name));
      conds.push(values.length === 1 ? eq(c, values[0]) : inArray(c, values));
    }
  }

  if (q.mine === '1' && def.assignees?.length) {
    conds.push(or(...def.assignees.map((a) => eq(col(def, a), actor.userId))));
  }

  const search = q.q?.trim();
  if (search) {
    const pattern = `%${escapeLike(search.slice(0, 100))}%`;
    const searchable = Object.entries(def.fields).filter(([, f]) => f.search && fieldReadable(f, actor));
    const parts = searchable.map(([k]) => ilike(sql`${col(def, k)}::text`, pattern));
    if (def.numbering) parts.push(ilike(col(def, def.numbering.field), pattern));
    conds.push(parts.length ? or(...parts) : sql`false`);
  }
  return and(...conds);
}

function orderBy(def: ResourceDef, sortParam?: string) {
  const s = sortParam || def.defaultSort || '-createdAt';
  const out: SQL[] = [];
  for (const part of s.split(',')) {
    const dir = part.startsWith('-') ? desc : asc;
    const name = part.replace(/^-/, '');
    if (name in def.fields || name === 'createdAt' || name === 'updatedAt') {
      const c = col(def, name);
      if (c) out.push(dir(c));
    }
  }
  out.push(asc(col(def, 'id')));
  return out;
}

export async function list(ctx: Ctx, key: string, q: ListQuery) {
  const def = requireResource(key);
  const where = buildWhere(def, ctx.actor, q);
  const pageSize = Math.min(Math.max(Number(q.pageSize) || 25, 1), 200);
  const page = Math.max(Number(q.page) || 1, 1);
  const [rows, [{ total }]] = await Promise.all([
    ctx.db.select().from(def.table).where(where).orderBy(...orderBy(def, q.sort)).limit(pageSize).offset((page - 1) * pageSize),
    ctx.db.select({ total: count() }).from(def.table).where(where),
  ]);
  return { rows: await serialize(ctx.db, def, ctx.actor, rows as Row[]), total: Number(total), page, pageSize };
}

export async function getOne(ctx: Ctx, key: string, id: string, action: ResourceAction = 'view'): Promise<Row> {
  const def = requireResource(key);
  if (!isUuid(id)) throw notFound(def.label);
  const [row] = await ctx.db.select().from(def.table)
    .where(and(eq(col(def, 'id'), id), scopeCondition(def, ctx.actor, action), notDeleted(def)));
  if (!row) throw notFound(def.label);
  return row as Row;
}

/** Strips unreadable fields and attaches display labels for references (`_labels`). */
export async function serialize(db: DB, def: ResourceDef, actor: Actor, rows: Row[]): Promise<Row[]> {
  if (!rows.length) return [];
  const hidden = Object.entries(def.fields).filter(([, f]) => !fieldReadable(f, actor)).map(([k]) => k);
  // Field permissions granted with a limited scope only apply to rows inside that scope.
  const limited = Object.entries(def.fields).filter(([k, f]) => f.readPermission && !hidden.includes(k) && actor.perms.get(f.readPermission) !== 'all');
  const inScope = new Map<string, Set<string>>();
  const scopeKey = (k: string, f: FieldDef) => f.readScope ? `field:${k}` : actor.perms.get(f.readPermission!)!;
  for (const [k, f] of limited) {
    const scope = actor.perms.get(f.readPermission!)!;
    const key = scopeKey(k, f);
    if (inScope.has(key)) continue;
    const rule = f.readScope ?? (scope === 'team' ? (def.scopes?.team ?? def.scopes?.own) : def.scopes?.own);
    const ids = rule ? (await db.select({ id: col(def, 'id') }).from(def.table).where(and(inArray(col(def, 'id'), rows.map((r) => r.id)), rule(actor)))).map((r: any) => r.id as string) : [];
    inScope.set(key, new Set(ids));
  }
  const refFields = Object.entries(def.fields).filter(([k, f]) => (f.type === 'ref' || f.type === 'stage') && !hidden.includes(k));

  const labelMaps = new Map<string, Map<string, string>>();
  const byTarget = new Map<string, Set<string>>();
  for (const [k, f] of refFields) {
    const target = f.type === 'stage' ? '__stage' : f.ref!;
    const set = byTarget.get(target) ?? new Set<string>();
    for (const r of rows) if (r[k]) set.add(r[k]);
    byTarget.set(target, set);
  }
  await Promise.all([...byTarget.entries()].map(async ([target, ids]) => {
    if (!ids.size) return;
    const m = new Map<string, string>();
    if (target === '__stage') {
      const st = await db.select({ id: pipelineStages.id, name: pipelineStages.name }).from(pipelineStages).where(inArray(pipelineStages.id, [...ids]));
      st.forEach((s) => m.set(s.id, s.name));
    } else {
      const t = getResource(target);
      if (!t) return;
      const titleExpr = t.titleSql ?? col(t, t.titleField);
      const res = await db.select({ id: col(t, 'id'), label: sql<string>`${titleExpr}` }).from(t.table).where(inArray(col(t, 'id'), [...ids]));
      res.forEach((r: any) => m.set(r.id, r.label));
    }
    labelMaps.set(target, m);
  }));

  return rows.map((r) => {
    const out: Row = { ...r };
    for (const k of hidden) delete out[k];
    for (const [k, f] of limited) if (!inScope.get(scopeKey(k, f))?.has(r.id)) delete out[k];
    const labels: Record<string, string> = {};
    for (const [k, f] of refFields) {
      if (r[k]) labels[k] = labelMaps.get(f.type === 'stage' ? '__stage' : f.ref!)?.get(r[k]) ?? '—';
    }
    out._labels = labels;
    out._title = def.formatTitle ? def.formatTitle(r) : r[def.titleField];
    return out;
  });
}

// ───────────────────────── Mutations ─────────────────────────

async function stageKey(db: DB, id: string | null | undefined) {
  if (!id) return null;
  const [s] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, id));
  return s ?? null;
}

async function checkRefs(ctx: Ctx, def: ResourceDef, data: Record<string, any>) {
  for (const [k, f] of Object.entries(def.fields)) {
    const v = data[k];
    if (v === undefined || v === null) continue;
    if (f.type === 'stage') {
      const s = await stageKey(ctx.db, v);
      if (!s || s.pipeline !== f.pipeline) throw invalid('Validation failed', { [k]: 'Invalid stage' });
      continue;
    }
    if (f.type !== 'ref') continue;
    const target = getResource(f.ref!);
    if (!target) continue; // FK constraint still guarantees existence
    let ok: boolean;
    if (target.directory) {
      ok = (await ctx.db.select({ id: col(target, 'id') }).from(target.table).where(eq(col(target, 'id'), v)).limit(1)).length > 0;
    } else {
      // Prevents attaching records to parents the actor cannot see (IDOR via foreign keys).
      ok = await isVisible(ctx.db, ctx.actor, target.key, v);
    }
    if (!ok) throw invalid('Validation failed', { [k]: `${f.label} not found or not accessible` });
  }
}

function parseBody(def: ResourceDef, actor: Actor, body: unknown, mode: 'create' | 'update', prev?: Row) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object');
  const input = body as Record<string, unknown>;
  const writable: Record<string, FieldDef> = {};
  for (const [k, f] of Object.entries(def.fields)) {
    if (!(k in input)) continue;
    if (f.readonly) continue; // computed / workflow-managed: ignored
    if (!fieldWritable(f, actor)) throw forbidden(`You cannot set "${f.label}"`);
    if (mode === 'update' && f.createOnly && input[k] !== prev?.[k]) throw invalid('Validation failed', { [k]: 'Cannot be changed after creation' });
    writable[k] = f;
  }
  if (mode === 'create') {
    for (const [k, f] of Object.entries(def.fields)) if (f.required && !f.readonly && !(k in writable) && f.default === undefined) writable[k] = f;
  }
  const parsed = objectSchema(writable, mode).safeParse(input);
  if (!parsed.success) throw invalid('Validation failed', formatZodError(parsed.error));
  const data: Record<string, any> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) data[k] = v;
  return data;
}

/** A field write permission held only at own/team scope applies only to rows inside that scope. */
async function checkScopedFieldWrites(ctx: Ctx, def: ResourceDef, data: Record<string, any>, prev?: Row) {
  for (const k of Object.keys(data)) {
    const f = def.fields[k];
    const p = f?.writePermission ?? f?.readPermission;
    if (!p) continue;
    const scope = ctx.actor.perms.get(p);
    if (!scope || scope === 'all') continue;
    if (!prev) throw forbidden(`You cannot set "${f.label}" here`);
    const rule = f.readScope ?? (scope === 'team' ? (def.scopes?.team ?? def.scopes?.own) : def.scopes?.own);
    const ok = rule && (await ctx.db.select({ id: col(def, 'id') }).from(def.table).where(and(eq(col(def, 'id'), prev.id), rule(ctx.actor))).limit(1)).length > 0;
    if (!ok) throw forbidden(`You cannot change "${f.label}" on this record`);
  }
}

function checkAssignment(def: ResourceDef, actor: Actor, data: Record<string, any>, prev?: Row) {
  const perm = assignPerm(def);
  if (!perm || can(actor, perm) || !def.assignees) return;
  for (const a of def.assignees) {
    if (!(a in data)) continue;
    const v = data[a];
    if (v !== null && v !== actor.userId && v !== prev?.[a]) throw forbidden('You can only assign records to yourself');
  }
}

async function userName(db: DB, id: string) {
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
  return u?.name ?? 'someone';
}

async function logActivity(db: DB, def: ResourceDef, id: string, actorUserId: string | null, verb: string, summary: string) {
  await db.insert(activities).values({ entityType: def.key, entityId: id, actorUserId, verb, summary });
}

export async function create(ctx: Ctx, key: string, body: unknown): Promise<Row> {
  const def = requireResource(key);
  const perm = permFor(def, 'create');
  if (!perm || !can(ctx.actor, perm)) throw forbidden();
  const data = parseBody(def, ctx.actor, body, 'create');
  for (const [k, f] of Object.entries(def.fields)) {
    if (data[k] === undefined && f.default !== undefined) {
      data[k] = typeof f.default === 'function' ? (f.default as (a: Actor) => unknown)(ctx.actor) : f.default;
    }
  }
  checkAssignment(def, ctx.actor, data);
  await checkScopedFieldWrites(ctx, def, data);
  await checkRefs(ctx, def, data);

  const row = await inTx(ctx, async (tx) => {
    const hc: HookCtx = { tx, actor: ctx.actor, requestId: ctx.requestId };
    if (def.numbering && !data[def.numbering.field]) {
      data[def.numbering.field] = await nextNumber(tx, def.numbering.key, def.numbering.prefix, def.numbering.pad);
    }
    await def.hooks?.beforeCreate?.(hc, data);
    const [created] = (await tx.insert(def.table).values(data).returning()) as Row[];
    await afterWrite(tx, def, ctx.actor, created, undefined);
    await def.hooks?.afterCreate?.(hc, created);
    return created;
  });
  return (await serialize(ctx.db, def, ctx.actor, [row]))[0];
}

export async function update(ctx: Ctx, key: string, id: string, body: unknown): Promise<Row> {
  const def = requireResource(key);
  const prev = await getOne(ctx, key, id, 'edit');
  const data = parseBody(def, ctx.actor, body, 'update', prev);
  checkAssignment(def, ctx.actor, data, prev);
  await checkScopedFieldWrites(ctx, def, data, prev);
  if (def.status && data[def.status.field] !== undefined && data[def.status.field] !== prev[def.status.field]) {
    const allowed = def.status.transitions?.[prev[def.status.field]];
    if (def.status.transitions && !allowed?.includes(data[def.status.field])) {
      throw invalid(`Cannot move from "${prev[def.status.field]}" to "${data[def.status.field]}"`, { [def.status.field]: 'Transition not allowed' });
    }
  }
  const changedRefs: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) if (v !== prev[k]) changedRefs[k] = v;
  await checkRefs(ctx, def, changedRefs);

  const row = await inTx(ctx, async (tx) => {
    const hc: HookCtx = { tx, actor: ctx.actor, requestId: ctx.requestId };
    await def.hooks?.beforeUpdate?.(hc, data, prev);
    if (!Object.keys(data).length) return prev;
    const [updated] = (await tx.update(def.table).set(data).where(eq(col(def, 'id'), id)).returning()) as Row[];
    await afterWrite(tx, def, ctx.actor, updated, prev);
    await def.hooks?.afterUpdate?.(hc, updated, prev);
    return updated;
  });
  return (await serialize(ctx.db, def, ctx.actor, [row]))[0];
}

/** Emits domain events and activity entries for a create/update. Also used by bespoke services. */
export async function afterWrite(tx: DB, def: ResourceDef, actor: Actor | null, row: Row, prev: Row | undefined) {
  const actorId = actor?.userId ?? null;
  const title = String((def.formatTitle ? def.formatTitle(row) : row[def.titleField]) ?? '');
  const base: Record<string, unknown> = { id: row.id, title };
  for (const k of def.eventFields ?? []) base[k] = row[k];
  if (!prev) {
    await emit(tx, { type: `${def.key}.created`, entityType: def.key, entityId: row.id, actorUserId: actorId, payload: base });
    await logActivity(tx, def, row.id, actorId, 'created', `created this ${def.label.toLowerCase()}`);
  } else {
    const changed = Object.keys(def.fields).filter((k) => String(row[k] ?? '') !== String(prev[k] ?? ''));
    if (!changed.length) return;
    await emit(tx, { type: `${def.key}.updated`, entityType: def.key, entityId: row.id, actorUserId: actorId, payload: { ...base, changed } });
    if (def.status && changed.includes(def.status.field)) {
      const [from, to] = [prev[def.status.field], row[def.status.field]];
      await emit(tx, { type: `${def.key}.status_changed`, entityType: def.key, entityId: row.id, actorUserId: actorId, payload: { ...base, from, to } });
      await logActivity(tx, def, row.id, actorId, 'status', `changed status from ${from ?? '—'} to ${to}`);
    }
    for (const [k, f] of Object.entries(def.fields)) {
      if (f.type !== 'stage' || !changed.includes(k)) continue;
      const [from, to] = await Promise.all([stageKey(tx, prev[k]), stageKey(tx, row[k])]);
      await emit(tx, { type: `${def.key}.stage_changed`, entityType: def.key, entityId: row.id, actorUserId: actorId, payload: { ...base, field: k, from: from?.key ?? null, to: to?.key ?? null } });
      await logActivity(tx, def, row.id, actorId, 'stage', `moved from ${from?.name ?? '—'} to ${to?.name ?? '—'}`);
    }
  }
  for (const a of def.assignees ?? []) {
    const v = row[a];
    if (v && v !== prev?.[a]) {
      await emit(tx, { type: `${def.key}.assigned`, entityType: def.key, entityId: row.id, actorUserId: actorId, payload: { ...base, field: a, userId: v } });
      await logActivity(tx, def, row.id, actorId, 'assigned', `assigned ${def.fields[a].label.toLowerCase()} to ${await userName(tx, v)}`);
    }
  }
}

export async function remove(ctx: Ctx, key: string, id: string) {
  const def = requireResource(key);
  const row = await getOne(ctx, key, id, 'delete');
  await inTx(ctx, async (tx) => {
    await def.hooks?.beforeDelete?.({ tx, actor: ctx.actor, requestId: ctx.requestId }, row);
    if (def.softDelete) {
      await tx.update(def.table).set({ [def.softDelete]: new Date() }).where(eq(col(def, 'id'), id));
    } else {
      try {
        await tx.delete(def.table).where(eq(col(def, 'id'), id));
      } catch (e: any) {
        const code = e?.code ?? e?.cause?.code;
        if (code === '23503') throw new AppError(409, 'in_use', `This ${def.label.toLowerCase()} is referenced by other records and cannot be deleted`);
        throw e;
      }
    }
    await def.hooks?.afterDelete?.({ tx, actor: ctx.actor, requestId: ctx.requestId }, row);
    await emit(tx, { type: `${def.key}.deleted`, entityType: def.key, entityId: id, actorUserId: ctx.actor.userId, payload: { id, title: row[def.titleField] } });
  });
}

// ───────────────────────── Options, export, meta ─────────────────────────

export async function options(ctx: Ctx, key: string, q: { q?: string; ids?: string; [k: string]: string | undefined }) {
  const def = requireResource(key);
  const titleExpr = def.titleSql ?? col(def, def.titleField);
  let where: SQL | undefined;
  if (def.directory) {
    const conds: (SQL | undefined)[] = [notDeleted(def)];
    if (q.q) conds.push(ilike(sql`${titleExpr}::text`, `%${escapeLike(q.q.slice(0, 100))}%`));
    where = and(...conds);
  } else {
    where = buildWhere(def, ctx.actor, { q: q.q });
  }
  if (q.ids) {
    const ids = q.ids.split(',').filter(isUuid);
    where = and(where, ids.length ? inArray(col(def, 'id'), ids) : sql`false`);
  }
  const rows = await ctx.db.select({ id: col(def, 'id'), label: sql<string>`${titleExpr}` }).from(def.table)
    .where(where).orderBy(sql`${titleExpr}`).limit(30);
  return rows;
}

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join('; ') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportCsv(ctx: Ctx, key: string, q: ListQuery): Promise<string> {
  const def = requireResource(key);
  const perm = permFor(def, 'export');
  if (!perm || !can(ctx.actor, perm)) throw forbidden();
  const where = buildWhere(def, ctx.actor, q);
  const rows = await ctx.db.select().from(def.table).where(where).orderBy(...orderBy(def, q.sort)).limit(10000);
  const out = await serialize(ctx.db, def, ctx.actor, rows as Row[]);
  const fields = Object.entries(def.fields).filter(([, f]) => fieldReadable(f, ctx.actor) && f.type !== 'markdown');
  const lines = [fields.map(([, f]) => csvCell(f.label)).join(',')];
  for (const r of out) {
    lines.push(fields.map(([k, f]) => csvCell(f.type === 'ref' || f.type === 'stage' ? r._labels[k] ?? '' : r[k])).join(','));
  }
  return lines.join('\r\n');
}

export function resourceMeta(def: ResourceDef, actor: Actor) {
  const fields = Object.fromEntries(
    Object.entries(def.fields).filter(([, f]) => fieldReadable(f, actor)).map(([k, f]) => [k, {
      type: f.type, label: f.label, required: !!f.required, readonly: !fieldWritable(f, actor), createOnly: !!f.createOnly,
      options: f.options, ref: f.ref, pipeline: f.pipeline, list: !!f.list, filter: !!f.filter, help: f.help,
      hidden: !!f.hidden, group: f.group, min: f.min, max: f.max,
    }]),
  );
  return {
    key: def.key, label: def.label, plural: def.plural, module: def.module, description: def.description,
    titleField: def.titleField, fields, defaultSort: def.defaultSort ?? '-createdAt',
    status: def.status ? { field: def.status.field, transitions: def.status.transitions } : undefined,
    numberField: def.numbering?.field, assignees: def.assignees, board: def.board,
    children: def.children?.filter((c) => { const t = getResource(c.resource); return t && canAction(t, actor, 'view'); }),
    collab: def.collab,
    can: {
      view: canAction(def, actor, 'view'), create: canAction(def, actor, 'create'), edit: canAction(def, actor, 'edit'),
      delete: canAction(def, actor, 'delete'), export: canAction(def, actor, 'export'),
    },
  };
}
