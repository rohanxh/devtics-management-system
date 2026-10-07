import { sql, type SQL } from 'drizzle-orm';
import type { Actor } from '../rbac/actor.ts';

/** Projects a user is involved in: PM, tech lead, creator, member, or the BD owner of the originating deal. */
export const myProjectIds = (userId: string): SQL => sql`(
  select p.id from projects p where p.pm_id = ${userId} or p.tech_lead_id = ${userId} or p.created_by = ${userId}
  union select m.project_id from project_members m where m.user_id = ${userId}
  union select o.project_id from opportunities o where o.owner_id = ${userId} and o.project_id is not null)`;

/** Projects a user manages (PM or tech lead). */
export const managedProjectIds = (userId: string): SQL => sql`(
  select p.id from projects p where p.pm_id = ${userId} or p.tech_lead_id = ${userId})`;

export const inMyProjects = (column: SQL | any, a: Actor): SQL => sql`${column} in ${myProjectIds(a.userId)}`;
export const inManagedProjects = (column: SQL | any, a: Actor): SQL => sql`${column} in ${managedProjectIds(a.userId)}`;

/** Tasks visible under "own" scope: assigned/reported by me or in my projects. */
export const myTaskIds = (userId: string): SQL => sql`(
  select t.id from tasks t where t.assignee_id = ${userId} or t.reporter_id = ${userId} or t.project_id in ${myProjectIds(userId)})`;
