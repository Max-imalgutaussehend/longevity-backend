import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Reusable schema refs ──────────────────────────────────────────────────────
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const auth401 = { 401: { description: 'Unauthenticated' } };
const cookieAuth = [{ cookieAuth: [] as string[] }];
const publicSecurity: never[] = [];

// ── Paths ─────────────────────────────────────────────────────────────────────
const paths: Record<string, unknown> = {};

paths['/healthz'] = {
  get: { operationId: 'healthz', tags: ['System'], security: publicSecurity, summary: 'Health check',
    responses: { 200: { description: 'OK' } } },
};

paths['/auth/register'] = {
  post: { operationId: 'register', tags: ['Auth'], security: publicSecurity, summary: 'Register',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['email', 'password', 'birthDate', 'sex'],
      properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 10 }, birthDate: { type: 'string', format: 'date' }, sex: { type: 'string', enum: ['m', 'f'] }, displayName: { type: 'string' } },
    } } } },
    responses: { 201: { description: 'Created' }, 400: { description: 'Validation error' }, 409: { description: 'Email taken' } } },
};

paths['/auth/login'] = {
  post: { operationId: 'login', tags: ['Auth'], security: publicSecurity, summary: 'Login',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } } },
    responses: { 200: { description: 'OK' }, 401: { description: 'Wrong credentials' }, 429: { description: 'Rate limited' } } },
};

paths['/auth/logout'] = {
  post: { operationId: 'logout', tags: ['Auth'], summary: 'Logout', responses: { 204: { description: 'OK' } } },
};

paths['/auth/verify-email'] = {
  post: { operationId: 'verifyEmail', tags: ['Auth'], security: publicSecurity, summary: 'Confirm email verification token',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['token'], properties: { token: { type: 'string' } },
    } } } },
    responses: { 200: { description: 'OK' }, 400: { description: 'Invalid, expired or used token' } } },
};

paths['/auth/resend-verification'] = {
  post: { operationId: 'resendVerification', tags: ['Auth'], summary: 'Resend the email verification link',
    responses: { 200: { description: 'OK' }, 400: { description: 'Already verified' }, ...auth401 } },
};

paths['/auth/request-password-reset'] = {
  post: { operationId: 'requestPasswordReset', tags: ['Auth'], security: publicSecurity, summary: 'Request a password reset link — always returns 200 to avoid leaking whether an email is registered',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } },
    } } } },
    responses: { 200: { description: 'OK' }, 400: { description: 'Missing email' }, 429: { description: 'Rate limited' } } },
};

paths['/auth/reset-password'] = {
  post: { operationId: 'resetPassword', tags: ['Auth'], security: publicSecurity, summary: 'Set a new password using a reset token',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['token', 'password'], properties: { token: { type: 'string' }, password: { type: 'string', minLength: 10 } },
    } } } },
    responses: { 200: { description: 'OK' }, 400: { description: 'Invalid, expired or used token, or weak password' } } },
};

paths['/auth/accept-invite'] = {
  post: { operationId: 'acceptInsurerInvite', tags: ['Auth'], security: publicSecurity, summary: 'Accept an insurer admin invitation and set a password',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['token', 'password'], properties: { token: { type: 'string' }, password: { type: 'string', minLength: 10 } },
    } } } },
    responses: { 200: { description: 'OK' }, 400: { description: 'Invalid, expired or used token, or weak password' } } },
};

paths['/auth/google/url'] = {
  post: { operationId: 'getGoogleAuthUrl', tags: ['Auth'], security: publicSecurity, summary: 'Get Google OAuth login URL',
    responses: { 200: { description: 'Google Auth URL', content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string', nullable: true } } } } } } } },
};

paths['/auth/google/callback'] = {
  get: { operationId: 'googleAuthCallback', tags: ['Auth'], security: publicSecurity, summary: 'Google OAuth login callback',
    parameters: [{ name: 'code', in: 'query', required: true, schema: { type: 'string' } }],
    responses: { 302: { description: 'Redirect to dashboard or register' }, 400: { description: 'Auth failed' } } },
};


paths['/me'] = {
  get: { operationId: 'getMe', tags: ['User'], summary: 'Get current user', responses: { 200: { description: 'User object', content: { 'application/json': { schema: ref('User') } } }, ...auth401 } },
};

paths['/organizations/join'] = {
  post: { operationId: 'joinOrganization', tags: ['Insurer'], summary: 'Link the current b2c user to an organization via join code',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['joinCode'], properties: { joinCode: { type: 'string' } },
    } } } },
    responses: { 200: { description: 'OK' }, 404: { description: 'Invalid join code' }, 403: { description: 'Not a b2c user' }, ...auth401 } },
};

paths['/organizations/leave'] = {
  post: { operationId: 'leaveOrganization', tags: ['Insurer'], summary: 'Unlink the current b2c user from their organization',
    responses: { 204: { description: 'OK' }, 403: { description: 'Not a b2c user' }, ...auth401 } },
};

paths['/insurer/overview'] = {
  get: { operationId: 'getInsurerOverview', tags: ['Insurer'], summary: 'Aggregate member metrics for the insurer dashboard — never individual health data',
    responses: { 200: { description: 'Aggregate overview' }, 403: { description: 'Not an insurer role' }, 404: { description: 'No organization assigned' }, ...auth401 } },
};

paths['/insurer/offers'] = {
  get: { operationId: 'listInsurerOffers', tags: ['Insurer'], summary: 'List the organization\'s own partner offers',
    responses: { 200: { description: 'PartnerOffer[]' }, 403: { description: 'Not an insurer role' }, 404: { description: 'No organization assigned' }, ...auth401 } },
  post: { operationId: 'createInsurerOffer', tags: ['Insurer'], summary: 'Create a partner offer for the organization',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['title', 'description', 'minBand', 'valueLabel'],
      properties: {
        title: { type: 'string' }, description: { type: 'string' }, minBand: { type: 'integer', minimum: 0, maximum: 100 },
        valueLabel: { type: 'string' }, validFrom: { type: 'string', format: 'date-time' }, validUntil: { type: 'string', format: 'date-time' },
      },
    } } } },
    responses: { 201: { description: 'Created' }, 400: { description: 'Validation error' }, 403: { description: 'Not an insurer role' }, 404: { description: 'No organization assigned' }, ...auth401 } },
};

paths['/insurer/offers/{id}'] = {
  patch: { operationId: 'updateInsurerOffer', tags: ['Insurer'], summary: 'Update one of the organization\'s own partner offers',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, description: { type: 'string' }, minBand: { type: 'integer', minimum: 0, maximum: 100 },
        valueLabel: { type: 'string' }, validFrom: { type: 'string', format: 'date-time', nullable: true }, validUntil: { type: 'string', format: 'date-time', nullable: true },
      },
    } } } },
    responses: { 200: { description: 'Updated' }, 400: { description: 'Validation error' }, 403: { description: 'Not an insurer role' }, 404: { description: 'Not found or not owned by this organization' }, ...auth401 } },
  delete: { operationId: 'deleteInsurerOffer', tags: ['Insurer'], summary: 'Delete one of the organization\'s own partner offers',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { 204: { description: 'Deleted' }, 403: { description: 'Not an insurer role' }, 404: { description: 'No organization assigned' }, ...auth401 } },
};

paths['/score/current'] = {
  get: { operationId: 'getScoreCurrent', tags: ['Score'], summary: 'Current score + lazy snapshot',
    responses: { 200: { description: 'ScoreResult', content: { 'application/json': { schema: ref('ScoreResult') } } }, ...auth401 } },
};

paths['/score/history'] = {
  get: { operationId: 'getScoreHistory', tags: ['Score'], summary: 'Score history',
    parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 90, maximum: 365 } }],
    responses: { 200: { description: 'HistoryPoint[]', content: { 'application/json': { schema: { type: 'array', items: ref('HistoryPoint') } } } }, ...auth401 } },
};

paths['/score/breakdown'] = {
  get: { operationId: 'getScoreBreakdown', tags: ['Score'], summary: 'Stored breakdown for a date',
    parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }],
    responses: { 200: { description: 'ScoreResult', content: { 'application/json': { schema: ref('ScoreResult') } } }, 404: { description: 'No snapshot' }, ...auth401 } },
};

paths['/score/levers'] = {
  get: { operationId: 'getScoreLevers', tags: ['Score'], summary: 'Top improvement levers',
    responses: { 200: { description: 'Levers array' }, ...auth401 } },
};

paths['/score/simulate'] = {
  post: { operationId: 'simulateScore', tags: ['Score'], summary: 'Simulate metric impact',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['metric', 'value'], properties: { metric: { type: 'string' }, value: { type: 'number' } } } } } },
    responses: { 200: { description: 'Simulation delta' }, ...auth401 } },
};

paths['/sources'] = {
  get: { operationId: 'getSources', tags: ['Sources'], summary: 'List data sources',
    responses: { 200: { description: 'Source[]', content: { 'application/json': { schema: { type: 'array', items: ref('Source') } } } }, ...auth401 } },
};

paths['/samples/summary'] = {
  get: { operationId: 'getSamplesSummary', tags: ['Samples'], summary: 'Get synchronized metrics summary and recent samples',
    responses: { 200: { description: 'SamplesSummaryResponse' }, ...auth401 } },
};

paths['/sources/{id}'] = {
  patch: { operationId: 'patchSource', tags: ['Sources'], summary: 'Enable/disable source',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } } },
    responses: { 204: { description: 'Updated' }, 404: { description: 'Not found' }, ...auth401 } },
};

paths['/sources/{id}/regenerate'] = {
  post: { operationId: 'regenerateSource', tags: ['Sources'], summary: 'Re-seed mock source',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { 200: { description: 'New sample count' }, ...auth401 } },
};

paths['/sources/apple-health/upload'] = {
  post: { operationId: 'uploadAppleHealth', tags: ['Sources'], summary: 'Upload Apple Health export.xml',
    requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
    responses: { 200: { description: 'Inserted count' }, ...auth401 } },
};

paths['/sources/health-auto-export/webhook'] = {
  post: { operationId: 'healthAutoExportWebhook', tags: ['Sources'], summary: 'Health Auto Export JSON webhook',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
    responses: { 200: { description: 'Inserted count' }, ...auth401 } },
};

paths['/sources/{provider}/connect'] = {
  post: { operationId: 'connectSourceProvider', tags: ['Sources'], summary: 'Start OAuth flow for a provider (withings, google-fit, oura, strava)',
    parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['withings', 'google-fit', 'oura', 'strava'] } }],
    responses: { 200: { description: 'Authorize URL' }, 404: { description: 'Unknown provider' }, ...auth401 } },
};

paths['/oauth/callback/{provider}'] = {
  get: { operationId: 'oauthCallback', tags: ['Sources'], summary: 'OAuth redirect target — exchanges code for tokens',
    parameters: [
      { name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['withings', 'google-fit', 'oura', 'strava'] } },
      { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
    ],
    responses: { 200: { description: 'Connected' }, 400: { description: 'Missing/invalid params' }, 404: { description: 'Unknown provider' } } },
};

paths['/sources/google/callback'] = {
  get: { operationId: 'googleSourcesCallback', tags: ['Sources'], summary: 'Alias for Google OAuth redirect callback',
    parameters: [
      { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
    ],
    responses: { 200: { description: 'Connected' }, 400: { description: 'Missing/invalid params' }, 404: { description: 'Unknown provider' } } },
};

paths['/sources/{provider}/exchange'] = {
  post: { operationId: 'exchangeSourceCode', tags: ['Sources'], summary: 'Exchange OAuth code manually for tokens and sync initial data',
    parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['withings', 'google-fit', 'google-health', 'oura', 'strava'] } }],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' }, redirectUri: { type: 'string' } } } } } },
    responses: { 200: { description: 'Connected and synced' }, 400: { description: 'Invalid code' }, 404: { description: 'Unknown provider' }, ...auth401 } },
};


paths['/sources/{id}/disconnect'] = {
  delete: { operationId: 'disconnectSource', tags: ['Sources'], summary: 'Remove OAuth credentials, keep samples unless deleteData is true',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'deleteData', in: 'query', required: false, schema: { type: 'boolean' } },
    ],
    responses: { 204: { description: 'Disconnected' }, 404: { description: 'Not found' }, ...auth401 } },
};

paths['/sources/{id}/samples'] = {
  delete: { operationId: 'deleteSourceSamples', tags: ['Sources'], summary: 'Delete all samples for a source',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { 204: { description: 'Samples deleted' }, 404: { description: 'Not found' }, ...auth401 } },
};

paths['/sources/withings/sync'] = {
  post: { operationId: 'syncWithings', tags: ['Sources'], summary: 'Pull latest measures/activity/sleep from Withings',
    responses: { 200: { description: 'Inserted count' }, 404: { description: 'Not connected' }, ...auth401 } },
};

paths['/sources/google-fit/sync'] = {
  post: { operationId: 'syncGoogleFit', tags: ['Sources'], summary: 'Pull latest steps/HR/sleep/active-minutes from Google Fit',
    responses: { 200: { description: 'Inserted count' }, 404: { description: 'Not connected' }, ...auth401 } },
};

paths['/sources/google-health/sync'] = {
  post: { operationId: 'syncGoogleHealth', tags: ['Sources'], summary: 'Pull latest steps/HR/sleep/active-minutes from Google Health',
    responses: { 200: { description: 'Inserted count' }, 404: { description: 'Not connected' }, ...auth401 } },
};


paths['/sources/oura/sync'] = {
  post: { operationId: 'syncOura', tags: ['Sources'], summary: 'Pull latest sleep/readiness/activity from Oura',
    responses: { 200: { description: 'Inserted count' }, 404: { description: 'Not connected' }, ...auth401 } },
};

paths['/sources/strava/sync'] = {
  post: { operationId: 'syncStrava', tags: ['Sources'], summary: 'Pull latest activities since last sync — strength_sessions + zone2_minutes',
    responses: { 200: { description: 'Inserted count' }, 404: { description: 'Not connected' }, ...auth401 } },
};

paths['/labs'] = {
  post: { operationId: 'postLabs', tags: ['Sources'], summary: 'Manual lab values',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['values'], properties: {
      values: { type: 'array', items: { type: 'object', required: ['metric', 'value', 'unit'], properties: { metric: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' }, measuredAt: { type: 'string', format: 'date-time' } } } },
    } } } } },
    responses: { 201: { description: 'Inserted metrics' }, ...auth401 } },
};

paths['/sources/fhir/upload'] = {
  post: { operationId: 'uploadFhir', tags: ['Sources'], summary: 'Import lab values from an HL7 FHIR R4 Bundle or Observation (LOINC-mapped, max 5MB)',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
    responses: { 201: { description: 'Inserted count' }, 400: { description: 'Invalid FHIR resource' }, ...auth401 } },
};

paths['/report/weekly'] = {
  get: { operationId: 'getWeeklyReport', tags: ['Report'], summary: 'Weekly score report',
    responses: { 200: { description: 'WeeklyReport', content: { 'application/json': { schema: ref('WeeklyReport') } } }, ...auth401 } },
};

paths['/report/send'] = {
  post: { operationId: 'sendWeeklyReport', tags: ['Report'], summary: 'Email weekly report', responses: { 200: { description: 'OK' }, ...auth401 } },
};

paths['/account'] = {
  delete: { operationId: 'deleteAccount', tags: ['Account'], summary: 'Delete account',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } } } } },
    responses: { 204: { description: 'Deleted' }, 401: { description: 'Wrong password' } } },
};

paths['/account/export'] = {
  get: { operationId: 'exportAccount', tags: ['Account'], summary: 'DSGVO Art. 20 data export — user, sources, samples, scoreSnapshots, shareTokens as JSON',
    responses: { 200: { description: 'Full account data export (application/json, Content-Disposition: attachment)' }, ...auth401 } },
};

paths['/account/consent'] = {
  get: { operationId: 'getAccountConsent', tags: ['Account'], summary: 'Get GDPR Art. 9 health data consent status and text',
    responses: { 200: { description: 'Consent status' }, ...auth401 } },
  post: { operationId: 'grantAccountConsent', tags: ['Account'], summary: 'Grant GDPR Art. 9 consent to process health data',
    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { version: { type: 'string' } } } } } },
    responses: { 200: { description: 'Consent recorded' }, ...auth401 } },
};

paths['/account/consent/revoke'] = {
  post: { operationId: 'revokeAccountConsent', tags: ['Account'], summary: 'Revoke GDPR Art. 9 health data consent (Art. 7(3) GDPR)',
    responses: { 200: { description: 'Consent revoked' }, ...auth401 } },
};

paths['/share-tokens'] = {
  get: { operationId: 'getShareTokens', tags: ['Share'], summary: 'List share tokens',
    responses: { 200: { description: 'ShareToken[]', content: { 'application/json': { schema: { type: 'array', items: ref('ShareToken') } } } }, ...auth401 } },
  post: { operationId: 'createShareToken', tags: ['Share'], summary: 'Create share token',
    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { days: { type: 'integer', enum: [30, 90, 180], default: 90 } } } } } },
    responses: { 201: { description: 'ShareToken', content: { 'application/json': { schema: ref('ShareToken') } } }, ...auth401 } },
};

paths['/share-tokens/{id}'] = {
  delete: { operationId: 'revokeShareToken', tags: ['Share'], summary: 'Revoke share token',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { 204: { description: 'Revoked' }, ...auth401 } },
};

paths['/verify/{id}'] = {
  get: { operationId: 'verifyToken', tags: ['Share'], security: publicSecurity, summary: 'Public: verify share token',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: { 200: { description: 'Verification result' } } },
};

paths['/partner-offers'] = {
  get: { operationId: 'getPartnerOffers', tags: ['Offers'], security: publicSecurity, summary: 'Partner offers',
    responses: { 200: { description: 'PartnerOffer[]', content: { 'application/json': { schema: { type: 'array', items: ref('PartnerOffer') } } } } } },
};

paths['/offers'] = {
  get: { operationId: 'getOffers', tags: ['Offers'], security: publicSecurity, summary: 'Alias for /partner-offers',
    responses: { 200: { description: 'PartnerOffer[]' } } },
};

// ── Components ────────────────────────────────────────────────────────────────
const schemas: Record<string, unknown> = {
  Error: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
  MetricResult: {
    type: 'object',
    required: ['metric', 'domain', 'value', 'unit', 'percentile', 'ageDays', 'freshness', 'effectiveWeight', 'contribution', 'available'],
    properties: {
      metric: { type: 'string' }, domain: { type: 'string' }, value: { type: ['number', 'null'] },
      unit: { type: 'string' }, percentile: { type: ['number', 'null'] }, ageDays: { type: ['number', 'null'] },
      freshness: { type: 'number' }, effectiveWeight: { type: 'number' }, contribution: { type: 'number' }, available: { type: 'boolean' },
    },
  },
  DomainResult: {
    type: 'object',
    required: ['domain', 'weight', 'score', 'metrics'],
    properties: {
      domain: { type: 'string' }, weight: { type: 'number' }, score: { type: 'number' },
      metrics: { type: 'array', items: ref('MetricResult') },
    },
  },
  ScoreResult: {
    type: 'object',
    required: ['score', 'coverage', 'bioAge', 'chronoAge', 'band', 'domains', 'engineVersion', 'computedAt'],
    properties: {
      score: { type: 'number' }, coverage: { type: 'number' }, bioAge: { type: 'number' }, chronoAge: { type: 'number' },
      band: { type: 'object', required: ['low', 'high'], properties: { low: { type: 'integer' }, high: { type: 'integer' } } },
      domains: { type: 'array', items: ref('DomainResult') },
      engineVersion: { type: 'string' }, computedAt: { type: 'string', format: 'date-time' },
    },
  },
  HistoryPoint: {
    type: 'object',
    required: ['date', 'score', 'coverage'],
    properties: {
      date: { type: 'string', format: 'date' }, score: { type: 'number' }, coverage: { type: 'number' },
    },
  },
  Source: {
    type: 'object',
    required: ['id', 'kind', 'adapter', 'enabled', 'lastSyncAt', 'sampleCount'],
    properties: {
      id: { type: 'string', format: 'uuid' }, kind: { type: 'string' }, adapter: { type: 'string' },
      enabled: { type: 'boolean' }, connected: { type: 'boolean' },
      syncStatus: { type: ['string', 'null'], enum: ['ok', 'token_expired', 'error', null] },
      syncError: { type: ['string', 'null'] },
      lastSyncAt: { type: ['string', 'null'], format: 'date-time' }, sampleCount: { type: 'integer' },
    },
  },

  ShareToken: {
    type: 'object',
    required: ['id', 'bandLow', 'bandHigh', 'issuedAt', 'expiresAt', 'revokedAt', 'partnerRef'],
    properties: {
      id: { type: 'string' }, bandLow: { type: 'integer' }, bandHigh: { type: 'integer' },
      issuedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' },
      revokedAt: { type: ['string', 'null'], format: 'date-time' }, partnerRef: { type: ['string', 'null'] },
    },
  },
  PartnerOffer: {
    type: 'object',
    required: ['id', 'partnerName', 'title', 'description', 'minBand', 'valueLabel', 'isDemo', 'qualified'],
    properties: {
      id: { type: 'string', format: 'uuid' }, partnerName: { type: 'string' }, title: { type: 'string' },
      description: { type: 'string' }, minBand: { type: 'integer' }, valueLabel: { type: 'string' },
      isDemo: { type: 'boolean' }, qualified: { type: 'boolean' },
    },
  },
  User: {
    type: 'object',
    required: ['id', 'email', 'displayName', 'birthDate', 'sex', 'chronoAge'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      displayName: { type: ['string', 'null'] },
      birthDate: { type: 'string', format: 'date' },
      sex: { type: 'string', enum: ['m', 'f'] },
      chronoAge: { type: 'number' },
    },
  },
  WeeklyReport: {
    type: 'object',
    properties: {
      weekStart: { type: 'string', format: 'date' }, scoreStart: { type: 'number' }, scoreEnd: { type: 'number' },
      delta: { type: 'number' }, bestMetric: { type: 'string' }, worstMetric: { type: 'string' }, streakDays: { type: 'integer' },
    },
  },
};

// ── Assemble spec ─────────────────────────────────────────────────────────────
const spec = {
  openapi: '3.1.0',
  info: { title: 'LONGEVITY API', version: '0.1.0', description: 'Health-score MVP — backend API' },
  servers: [{ url: '/api' }],
  security: cookieAuth,
  components: { securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sessionId' } }, schemas },
  paths,
};

const outPath = resolve(process.cwd(), 'openapi.json');
writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
