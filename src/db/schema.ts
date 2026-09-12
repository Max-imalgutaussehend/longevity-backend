import { pgTable, uuid, text, boolean, timestamp, date, doublePrecision, bigserial, jsonb, integer, index, unique } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  birthDate: date('birth_date').notNull(),
  sex: text('sex').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ userIdx: index().on(t.userId) }));

export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  adapter: text('adapter').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  consentAt: timestamp('consent_at', { withTimezone: true }),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  credentials: jsonb('credentials').$type<OAuthCredentials>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: unique().on(t.userId, t.kind) }));

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
}

export const samples = pgTable('samples', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  metric: text('metric').notNull(),
  value: doublePrecision('value').notNull(),
  unit: text('unit').notNull(),
  measuredAt: timestamp('measured_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userMetricTimeIdx: index().on(t.userId, t.metric, t.measuredAt),
  uniq: unique().on(t.userId, t.metric, t.measuredAt),
}));

export const scoreSnapshots = pgTable('score_snapshots', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  computedFor: date('computed_for').notNull(),
  score: doublePrecision('score').notNull(),
  coverage: doublePrecision('coverage').notNull(),
  bioAge: doublePrecision('bio_age').notNull(),
  breakdown: jsonb('breakdown').notNull(),
  engineVersion: text('engine_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: unique().on(t.userId, t.computedFor) }));

export const shareTokens = pgTable('share_tokens', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bandLow: integer('band_low').notNull(),
  bandHigh: integer('band_high').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  partnerRef: text('partner_ref'),
  signature: text('signature').notNull(),
}, (t) => ({ userIdx: index().on(t.userId) }));

export const partnerOffers = pgTable('partner_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerName: text('partner_name').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  minBand: integer('min_band').notNull(),
  valueLabel: text('value_label').notNull(),
  isDemo: boolean('is_demo').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});
