import { timestamp, uuid, numeric } from 'drizzle-orm/pg-core';

export const id = () => uuid().primaryKey().defaultRandom();

export const timestamps = {
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

/** Money: numeric(14,2). Drizzle returns strings; services convert explicitly. */
export const money = () => numeric({ precision: 14, scale: 2 });

export const tstz = () => timestamp({ withTimezone: true });
