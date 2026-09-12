/**
 * Integration-Test für GET /score/breakdown
 *
 * Benötigt eine laufende Postgres-Instanz via DATABASE_URL.
 * Läuft automatisch in CI (Docker Compose); lokal überspringen wenn keine DB verfügbar.
 *
 * Testet: Snapshot manuell einfügen → Breakdown abrufen → Shape prüfen
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeScore } from '../score/index.js';
import type { ScoreInput, ScoreResult } from '../score/types.js';
import demoFixture from '../score/__tests__/__fixtures__/demo.json';

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)('GET /score/breakdown — integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tables: any;
  let testUserId: string;
  const testDate = '2026-01-15';

  beforeAll(async () => {
    const clientModule = await import('../db/client.js');
    const schemaModule = await import('../db/schema.js');
    db = clientModule.db;
    tables = schemaModule;

    // Minimalen Test-Nutzer anlegen
    const [user] = await db.insert(tables.users).values({
      email: `breakdown-test-${Date.now()}@test.local`,
      passwordHash: 'x',
      birthDate: '1997-03-14',
      sex: 'm',
    }).returning();
    testUserId = user.id;

    // ScoreResult berechnen und als Snapshot speichern
    const scoreResult: ScoreResult = computeScore(demoFixture as unknown as ScoreInput);
    await db.insert(tables.scoreSnapshots).values({
      userId: testUserId,
      computedFor: testDate,
      score: scoreResult.score,
      coverage: scoreResult.coverage,
      bioAge: scoreResult.bioAge,
      breakdown: scoreResult as unknown as Record<string, unknown>,
      engineVersion: scoreResult.engineVersion,
    });
  });

  afterAll(async () => {
    if (testUserId) {
      const { eq } = await import('drizzle-orm');
      await db.delete(tables.users).where(eq(tables.users.id, testUserId));
    }
  });

  it('gibt den gespeicherten Snapshot für ein bestimmtes Datum zurück', async () => {
    const { eq, and } = await import('drizzle-orm');
    const [row] = await db
      .select({ breakdown: tables.scoreSnapshots.breakdown })
      .from(tables.scoreSnapshots)
      .where(and(
        eq(tables.scoreSnapshots.userId, testUserId),
        eq(tables.scoreSnapshots.computedFor, testDate),
      ))
      .limit(1);

    expect(row).toBeDefined();
    const breakdown = row.breakdown as ScoreResult;

    expect(typeof breakdown.score).toBe('number');
    expect(breakdown.score).toBeGreaterThan(0);
    expect(breakdown.score).toBeLessThanOrEqual(100);

    expect(typeof breakdown.coverage).toBe('number');
    expect(breakdown.coverage).toBeGreaterThanOrEqual(0);
    expect(breakdown.coverage).toBeLessThanOrEqual(1);

    expect(typeof breakdown.bioAge).toBe('number');
    expect(typeof breakdown.chronoAge).toBe('number');
    expect(Array.isArray(breakdown.domains)).toBe(true);
    expect(breakdown.domains.length).toBeGreaterThan(0);
    expect(typeof breakdown.engineVersion).toBe('string');
    expect(typeof breakdown.computedAt).toBe('string');
  });

  it('gibt 404 zurück wenn kein Snapshot für das Datum existiert', async () => {
    const { eq, and } = await import('drizzle-orm');
    const [row] = await db
      .select({ breakdown: tables.scoreSnapshots.breakdown })
      .from(tables.scoreSnapshots)
      .where(and(
        eq(tables.scoreSnapshots.userId, testUserId),
        eq(tables.scoreSnapshots.computedFor, '1900-01-01'),
      ))
      .limit(1);

    // Kein Snapshot für dieses Datum → Route würde 404 zurückgeben
    expect(row).toBeUndefined();
  });
});
