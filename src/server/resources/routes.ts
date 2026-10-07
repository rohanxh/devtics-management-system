import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ctxOf } from '../app.ts';
import { badRequest } from '../core/errors.ts';
import * as engine from './engine.ts';

type P = { key: string; id: string };
type Q = Record<string, string | undefined>;

export async function resourceRoutes(app: FastifyInstance) {
  const kick = () => app.deps.events.kick();

  app.get<{ Params: P; Querystring: Q }>('/api/r/:key', async (req) => engine.list(ctxOf(req), req.params.key, req.query));

  app.get<{ Params: P; Querystring: Q }>('/api/r/:key/options', async (req) => engine.options(ctxOf(req), req.params.key, req.query));

  app.get<{ Params: P; Querystring: Q }>('/api/r/:key/export.csv', async (req, reply) => {
    const csv = await engine.exportCsv(ctxOf(req), req.params.key, req.query);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${req.params.key.replace(/[^a-z0-9_-]/gi, '')}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return '﻿' + csv;
  });

  app.get<{ Params: P }>('/api/r/:key/:id', async (req) => {
    const ctx = ctxOf(req);
    const def = engine.requireResource(req.params.key);
    const row = await engine.getOne(ctx, req.params.key, req.params.id);
    const [out] = await engine.serialize(ctx.db, def, ctx.actor, [row]);
    return {
      ...out,
      _can: {
        edit: await canOnRecord(ctx, req.params.key, req.params.id, 'edit'),
        delete: await canOnRecord(ctx, req.params.key, req.params.id, 'delete'),
      },
    };
  });

  app.post<{ Params: P }>('/api/r/:key', async (req, reply) => {
    const row = await engine.create(ctxOf(req), req.params.key, req.body);
    kick();
    return reply.status(201).send(row);
  });

  app.patch<{ Params: P }>('/api/r/:key/:id', async (req) => {
    const row = await engine.update(ctxOf(req), req.params.key, req.params.id, req.body);
    kick();
    return row;
  });

  app.delete<{ Params: P }>('/api/r/:key/:id', async (req) => {
    await engine.remove(ctxOf(req), req.params.key, req.params.id);
    kick();
    return { ok: true };
  });

  /** Bulk update / delete. Each record is authorized individually; partial failures are reported. */
  app.post<{ Params: P }>('/api/r/:key/bulk', async (req) => {
    const ctx = ctxOf(req);
    const body = z.object({
      ids: z.array(z.uuid()).min(1).max(200),
      action: z.enum(['update', 'delete']),
      data: z.record(z.string(), z.unknown()).optional(),
    }).safeParse(req.body);
    if (!body.success) throw badRequest('Invalid bulk request');
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of body.data.ids) {
      try {
        if (body.data.action === 'delete') await engine.remove(ctx, req.params.key, id);
        else await engine.update(ctx, req.params.key, id, body.data.data ?? {});
        results.push({ id, ok: true });
      } catch (e: any) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    kick();
    return { results };
  });
}

async function canOnRecord(ctx: ReturnType<typeof ctxOf>, key: string, id: string, action: 'edit' | 'delete') {
  try {
    await engine.getOne(ctx, key, id, action);
    return true;
  } catch {
    return false;
  }
}
