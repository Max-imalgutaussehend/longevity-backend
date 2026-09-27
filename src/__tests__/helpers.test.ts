process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://longevity:longevity_dev@localhost:5432/longevity';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-bytes-long!';

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

type HelpersModule = typeof import('../routes/helpers.js');

describe('Route Helpers (helpers.ts)', () => {
  let METRIC_LABELS: HelpersModule['METRIC_LABELS'];
  let DOMAIN_LABELS: HelpersModule['DOMAIN_LABELS'];
  let requireUser: HelpersModule['requireUser'];
  let requireRole: HelpersModule['requireRole'];

  beforeAll(async () => {
    const mod = await import('../routes/helpers.js');
    METRIC_LABELS = mod.METRIC_LABELS;
    DOMAIN_LABELS = mod.DOMAIN_LABELS;
    requireUser = mod.requireUser;
    requireRole = mod.requireRole;
  });

  describe('METRIC_LABELS', () => {
    it('defines readable German labels for standard metrics', () => {
      expect(METRIC_LABELS.resting_hr).toBe('Ruhepuls');
      expect(METRIC_LABELS.vo2max).toBe('VO₂max');
      expect(METRIC_LABELS.hrv_rmssd).toBe('HRV (RMSSD)');
      expect(METRIC_LABELS.sleep_duration).toBe('Schlafdauer');
      expect(METRIC_LABELS.steps).toBe('Schritte');
      expect(METRIC_LABELS.smoking).toBe('Rauchen');
    });
  });

  describe('DOMAIN_LABELS', () => {
    it('defines readable German labels for health domains', () => {
      expect(DOMAIN_LABELS.cardiometabolic).toBe('Kardiometabolik');
      expect(DOMAIN_LABELS.recovery).toBe('Regeneration');
      expect(DOMAIN_LABELS.activity).toBe('Aktivität');
      expect(DOMAIN_LABELS.risk).toBe('Risiko');
    });
  });

  describe('requireUser', () => {
    it('returns 401 when req.session.userId is not set', async () => {
      const mockReq = {
        session: {},
      } as unknown as FastifyRequest;

      const sendFn = vi.fn();
      const statusFn = vi.fn().mockReturnValue({ send: sendFn });
      const mockReply = {
        status: statusFn,
      } as unknown as FastifyReply;

      const user = await requireUser(mockReq, mockReply);

      expect(user).toBeNull();
      expect(statusFn).toHaveBeenCalledWith(401);
      expect(sendFn).toHaveBeenCalledWith({ title: 'Nicht angemeldet.' });
    });
  });

  describe('requireRole', () => {
    it('returns 401 when req.session.userId is missing', async () => {
      const mockReq = {
        session: {},
      } as unknown as FastifyRequest;

      const sendFn = vi.fn();
      const statusFn = vi.fn().mockReturnValue({ send: sendFn });
      const mockReply = {
        status: statusFn,
      } as unknown as FastifyReply;

      const result = await requireRole(mockReq, mockReply, ['insurer_admin']);

      expect(result).toBeNull();
      expect(statusFn).toHaveBeenCalledWith(401);
      expect(sendFn).toHaveBeenCalledWith({ title: 'Nicht angemeldet.' });
    });
  });
});
