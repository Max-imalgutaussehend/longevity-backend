import type { SessionStore } from '@fastify/session';
import type { FastifySessionObject } from '@fastify/session';
import { db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { eq, lt } from 'drizzle-orm';

export class PgSessionStore implements SessionStore {
  private pruneIntervalMs: number;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { pruneIntervalMs?: number } = {}) {
    this.pruneIntervalMs = opts.pruneIntervalMs ?? 60 * 60 * 1000;
    this.startPruning();
  }

  private startPruning() {
    this.pruneTimer = setInterval(async () => {
      try {
        await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
      } catch {
        // non-fatal
      }
    }, this.pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  set(sessionId: string, session: { userId?: string; cookie: { expires?: Date | null } }, callback: (err?: Error) => void): void {
    const expiresAt = session.cookie?.expires
      ? new Date(session.cookie.expires)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const userId = session.userId;
    if (!userId) {
      // Don't persist unauthenticated sessions
      callback();
      return;
    }

    db.insert(sessions)
      .values({ id: sessionId, userId, expiresAt })
      .onConflictDoUpdate({
        target: sessions.id,
        set: { userId, expiresAt },
      })
      .then(() => callback())
      .catch((err: Error) => callback(err));
  }

  get(sessionId: string, callback: (err: Error | null, session?: FastifySessionObject | null) => void): void {
    db.select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .then(([row]) => {
        if (!row || row.expiresAt < new Date()) {
          callback(null, null);
          return;
        }
        callback(null, { userId: row.userId, cookie: { expires: row.expiresAt } } as unknown as FastifySessionObject);
      })
      .catch((err: Error) => callback(err));
  }

  destroy(sessionId: string, callback: (err?: Error) => void): void {
    db.delete(sessions)
      .where(eq(sessions.id, sessionId))
      .then(() => callback())
      .catch((err: Error) => callback(err));
  }
}
