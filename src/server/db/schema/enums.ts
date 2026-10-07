import { pgEnum } from 'drizzle-orm/pg-core';

/** Enums shared by several modules. */
export const projectType = pgEnum('project_type', ['website', 'wordpress', 'woocommerce', 'web_app', 'mobile_app', 'seo', 'maintenance', 'design', 'other']);
