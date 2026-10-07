import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.ts';
import type { DB } from './db/client.ts';
import type { EventProcessor } from './core/events.ts';
import type { Storage } from './core/storage.ts';
import { AppError, unauthorized } from './core/errors.ts';
import type { Ctx } from './core/context.ts';
import { loadActor } from './rbac/actor.ts';
import { resolveSession, SESSION_COOKIE } from './auth/sessions.ts';
import type { sessions } from './db/schema/index.ts';

export interface AppDeps {
  db: DB;
  config: Config;
  events: EventProcessor;
  storage: Storage;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: Ctx;
    session?: typeof sessions.$inferSelect;
  }
  interface FastifyInstance {
    deps: AppDeps;
  }
}

/** Returns the authenticated request context or throws 401. */
export function ctxOf(req: FastifyRequest): Ctx {
  if (!req.ctx) throw unauthorized();
  return req.ctx;
}

const PUBLIC_API = new Set(['/api/auth/login', '/api/health']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: AppDeps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: deps.config.NODE_ENV === 'production',
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
  });
  app.decorate('deps', deps);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline style attributes used by charts
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10 } });

  // Authentication + CSRF for the API.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const urlPath = req.url.split('?')[0];

    if (MUTATING.has(req.method)) {
      // CSRF (OWASP): custom request header cannot be set cross-origin without CORS, which is not enabled.
      if (req.headers['x-requested-with'] !== 'dms') throw new AppError(403, 'csrf', 'Missing CSRF header');
      const origin = req.headers.origin;
      if (origin && origin !== deps.config.APP_ORIGIN && origin !== `${req.protocol}://${req.host}`) {
        throw new AppError(403, 'csrf', 'Cross-origin request rejected');
      }
    }
    if (PUBLIC_API.has(urlPath)) return;

    const limits = { idleHours: deps.config.SESSION_IDLE_HOURS, maxDays: deps.config.SESSION_MAX_DAYS };
    const session = await resolveSession(deps.db, req.cookies[SESSION_COOKIE], limits);
    if (!session) throw unauthorized();
    const actor = await loadActor(deps.db, session.userId);
    if (!actor) throw unauthorized();
    req.session = session;
    req.ctx = { db: deps.db, actor, requestId: req.id, ip: req.ip };

    // Users with a temporary password may only change it.
    if (actor.mustChangePassword && !['/api/auth/me', '/api/auth/change-password', '/api/auth/logout'].includes(urlPath)) {
      throw new AppError(403, 'password_change_required', 'You must change your password before continuing');
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.validation) {
      return reply.status(400).send({ error: { code: 'bad_request', message: err.message } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    }
    req.log.error(err);
    if (!opts.logger) console.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong. Reference: ' + req.id } });
  });

  app.get('/api/health', async () => ({ ok: true }));

  const { registerRoutes } = await import('./routes.ts');
  await registerRoutes(app);

  // Serve the built SPA in production.
  const webRoot = path.resolve(import.meta.dirname, '../../dist/web');
  const hasWeb = fs.existsSync(path.join(webRoot, 'index.html'));
  if (hasWeb) await app.register(fastifyStatic, { root: webRoot, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    if (hasWeb) return reply.sendFile('index.html');
    return reply.status(404).send('Not found');
  });

  return app;
}
