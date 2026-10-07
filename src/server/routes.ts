import type { FastifyInstance } from 'fastify';
// Side-effect imports: register resources, automation actions and rules.
import './resources/defs/index.ts';
import './core/actions.ts';
import './modules/rules.ts';
import { authRoutes } from './auth/routes.ts';
import { resourceRoutes } from './resources/routes.ts';
import { collabRoutes } from './modules/collab.ts';
import { adminRoutes } from './modules/admin.ts';
import { platformRoutes } from './modules/platform.ts';

export async function registerRoutes(app: FastifyInstance) {
  await authRoutes(app);
  await resourceRoutes(app);
  await collabRoutes(app);
  await adminRoutes(app);
  await platformRoutes(app);
}
