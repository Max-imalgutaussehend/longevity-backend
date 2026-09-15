import { randomBytes } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { emailTokens } from '../db/schema.js';
import type { EmailTokenPurpose } from '../db/schema.js';

const TOKEN_TTL_MS = 60 * 60 * 1000;

export async function issueEmailToken(userId: string, purpose: EmailTokenPurpose): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.insert(emailTokens).values({ id, userId, purpose, expiresAt });
  return id;
}

export type EmailTokenResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'used' };

export async function consumeEmailToken(id: string, purpose: EmailTokenPurpose): Promise<EmailTokenResult> {
  const [token] = await db.select().from(emailTokens)
    .where(and(eq(emailTokens.id, id), eq(emailTokens.purpose, purpose)))
    .limit(1);

  if (!token) return { ok: false, reason: 'not_found' };
  if (token.usedAt) return { ok: false, reason: 'used' };
  if (new Date() > token.expiresAt) return { ok: false, reason: 'expired' };

  await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, id));
  return { ok: true, userId: token.userId };
}
