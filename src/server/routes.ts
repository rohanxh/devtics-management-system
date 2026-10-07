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
import { salesRoutes } from './modules/sales.ts';
import { deliveryRoutes } from './modules/delivery.ts';
import './modules/clients.ts';
import { reportRoutes } from './modules/reports.ts';
import { qaRoutes } from './modules/qa.ts';
import { financeRoutes } from './modules/finance.ts';
import { hrRoutes } from './modules/hr.ts';
import './modules/kpi.ts';
import './modules/it.ts';
import './modules/marketing.ts';
import { supportRoutes } from './modules/support.ts';
import { kbRoutes } from './modules/kb.ts';

export async function registerRoutes(app: FastifyInstance) {
  await authRoutes(app);
  await resourceRoutes(app);
  await collabRoutes(app);
  await adminRoutes(app);
  await platformRoutes(app);
  await salesRoutes(app);
  await deliveryRoutes(app);
  await reportRoutes(app);
  await qaRoutes(app);
  await financeRoutes(app);
  await hrRoutes(app);
  await supportRoutes(app);
  await kbRoutes(app);
}
