import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, date, doublePrecision, bigserial, jsonb, integer, index, unique, uniqueIndex } from 'drizzle-orm/pg-core';

export const ROLES = ['b2c', 'insurer_admin', 'insurer_staff', 'platform_admin'] as const;
export type Role = typeof ROLES[number];

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  contactEmail: text('contact_email').notNull(),
  status: text('status').notNull().default('pending'),
  joinCode: text('join_code').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  birthDate: date('birth_date').notNull(),
  sex: text('sex').notNull(),
  displayName: text('display_name'),
  role: text('role').notNull().default('b2c'),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
  organizationVerifiedAt: timestamp('organization_verified_at', { withTimezone: true }),
  kvnrHash: text('kvnr_hash').unique(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  healthDataConsentAt: timestamp('health_data_consent_at', { withTimezone: true }),
  healthDataConsentVersion: text('health_data_consent_version'),
  webhookSecret: text('webhook_secret').unique().notNull().default(sql`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`).$defaultFn(() => crypto.randomBytes(32).toString('hex')),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ orgIdx: index().on(t.organizationId) }));

export const emailTokens = pgTable('email_tokens', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ userIdx: index().on(t.userId) }));

export type EmailTokenPurpose = 'verify_email' | 'reset_password' | 'insurer_invite' | 'delete_account';

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ userIdx: index().on(t.userId) }));

export type SyncStatus = 'ok' | 'token_expired' | 'error';

export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  adapter: text('adapter').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  consentAt: timestamp('consent_at', { withTimezone: true }),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  syncStatus: text('sync_status').$type<SyncStatus>().default('ok'),
  syncError: text('sync_error'),
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

export interface ShareTokenMetadata {
  verifiedOnly: boolean;
  trustLevel: 'unverified' | 'cloud_verified' | 'certified_medical';
  verifiedSources: string[];
  totalSampleCount: number;
  excludedSampleCount: number;
  activeDays: number;
  certificateType: string;
}

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
  metadata: jsonb('metadata').$type<ShareTokenMetadata>(),
}, (t) => ({ userIdx: index().on(t.userId) }));

export const BENEFIT_TYPES = ['payout', 'voucher', 'certificate'] as const;
export type BenefitType = typeof BENEFIT_TYPES[number];

export const partnerOffers = pgTable('partner_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerName: text('partner_name').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  minBand: integer('min_band').notNull(),
  minMonths: integer('min_months'),
  valueLabel: text('value_label').notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  isDemo: boolean('is_demo').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  // When an offer belongs to an organization (issue #84), the insurer chooses
  // whether it's exclusive to their own verified members or visible to all
  // users as a general promotion. Meaningless for organization-less offers,
  // which are always visible to everyone regardless of this flag.
  membersOnly: boolean('members_only').notNull().default(true),
  benefitType: text('benefit_type').$type<BenefitType>().notNull().default('payout'),
  voucherCode: text('voucher_code'),
  partnerUrl: text('partner_url'),
}, (t) => ({ orgIdx: index().on(t.organizationId) }));

export const BENEFIT_CLAIM_STATUSES = ['submitted', 'accepted', 'rejected'] as const;
export type BenefitClaimStatus = typeof BENEFIT_CLAIM_STATUSES[number];

export const PAYOUT_METHODS = ['bank_transfer', 'contribution_offset', 'voucher', 'self_submitted'] as const;
export type PayoutMethod = typeof PAYOUT_METHODS[number];

export interface RewardPayload {
  voucherCode?: string;
  transactionRef?: string;
  note?: string;
  partnerUrl?: string;
}

// A direct in-portal submission of a qualified partner offer to its issuing
// insurer organization (issue #87) — replaces manual link-sharing for offers
// that have an organizationId. Snapshots the qualifying band/proof details
// at submission time so a later score change can't retroactively alter what
// was actually submitted and reviewed.
export const benefitClaims = pgTable('benefit_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  offerId: uuid('offer_id').notNull().references(() => partnerOffers.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  shareTokenId: text('share_token_id').notNull().references(() => shareTokens.id, { onDelete: 'cascade' }),
  bandLow: integer('band_low').notNull(),
  bandHigh: integer('band_high').notNull(),
  status: text('status').notNull().$type<BenefitClaimStatus>().default('submitted'),
  payoutMethod: text('payout_method').$type<PayoutMethod>().default('bank_transfer'),
  payoutIbanMasked: text('payout_iban_masked'),
  payoutAccountHolder: text('payout_account_holder'),
  rewardPayload: jsonb('reward_payload').$type<RewardPayload>(),
  rejectionReason: text('rejection_reason'),
  selfSubmittedAt: timestamp('self_submitted_at', { withTimezone: true }),
  reminderAt: timestamp('reminder_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => ({
  userIdx: index().on(t.userId),
  orgIdx: index().on(t.organizationId),
  // One active (non-rejected) claim per user+offer — resubmission after a
  // rejection is allowed (partial index excludes rejected rows), but not
  // while a claim is pending or accepted.
  uniqActiveClaim: uniqueIndex('benefit_claims_active_unique')
    .on(t.userId, t.offerId)
    .where(sql`${t.status} != 'rejected'`),
}));

export const healthDataConsents = pgTable('health_data_consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  version: text('version').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
}, (t) => ({ userIdx: index().on(t.userId) }));

export type InsurerRequestStatus = 'pending' | 'approved' | 'rejected';

export const insurerRequests = pgTable('insurer_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  company: text('company').notNull(),
  contactName: text('contact_name').notNull(),
  contactEmail: text('contact_email').notNull(),
  message: text('message'),
  status: text('status').$type<InsurerRequestStatus>().notNull().default('pending'),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ statusIdx: index().on(t.status) }));

