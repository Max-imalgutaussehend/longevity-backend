import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../env.js';
import { db } from '../db/client.js';
import { users, organizations, sessions } from '../db/schema.js';
import { isWeakPassword } from '../lib/weakPasswords.js';
import { hashPassword, verifyPasswordWithRehash, passwordSchema } from '../lib/password.js';
import { issueEmailToken, consumeEmailToken } from '../lib/emailTokens.js';
import { sendMail } from '../lib/mail.js';
import { verifyEmailTemplate, passwordResetTemplate } from '../lib/emailTemplates.js';
import { requireUser } from './helpers.js';
import { setCsrfCookies, clearCsrfCookies } from '../lib/csrf.js';
import { signAntiCsrfState, verifyAntiCsrfState } from '../lib/oauthState.js';
import '../types.js';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Ungültige E-Mail-Adresse.'),
  password: passwordSchema,
  birthDate: z.string().refine((val) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
    const d = new Date(val + 'T00:00:00Z');
    if (isNaN(d.getTime())) return false;
    const year = d.getUTCFullYear();
    if (year < 1900) return false;
    const now = new Date();
    if (d > now) return false;
    const minAgeDate = new Date(Date.UTC(now.getUTCFullYear() - 16, now.getUTCMonth(), now.getUTCDate()));
    return d <= minAgeDate;
  }, {
    message: 'Ungültiges Geburtsdatum. Das Mindestalter beträgt 16 Jahre (Geburtsjahr ab 1900).',
  }),
  sex: z.enum(['m', 'f'], { errorMap: () => ({ message: 'Ungültiges Geschlecht.' }) }),
  displayName: z.string().max(100).optional(),
});

export async function authRoutes(app: FastifyInstance) {
  app.get('/csrf', async (req, reply) => {
    const csrfToken = setCsrfCookies(reply);
    return { csrfToken };
  });
  app.post('/register', {
    config: {
      rateLimit: {
        max: env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || !!process.env.CI ? 200 : 5,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({ statusCode: 429, title: 'Zu viele Registrierungsversuche. Bitte in 15 Minuten erneut versuchen.' }),
      },
    },
  }, async (req, reply) => {
    const rawBody = (req.body as Record<string, unknown>) || {};
    const { email, password, birthDate, sex } = rawBody as { email?: string; password?: string; birthDate?: string; sex?: string };

    if (!email || !password || !birthDate || !sex) {
      return reply.status(400).send({ title: 'Pflichtfelder fehlen.' });
    }

    const parseResult = registerSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return reply.status(400).send({
        title: parseResult.error.issues[0]?.message ?? 'Ungültige Registrierungsdaten.',
      });
    }

    const { email: cleanEmail, password: cleanPassword, birthDate: cleanBirthDate, sex: cleanSex, displayName } = parseResult.data;

    if (isWeakPassword(cleanPassword)) {
      return reply.status(400).send({ title: 'Dieses Passwort ist zu häufig. Bitte wähle ein sichereres Passwort.' });
    }

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, cleanEmail)).limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({ title: 'E-Mail bereits vergeben.' });
    }

    const passwordHash = await hashPassword(cleanPassword);
    const [user] = await db.insert(users).values({
      email: cleanEmail,
      passwordHash,
      birthDate: cleanBirthDate,
      sex: cleanSex,
      displayName: displayName ?? null,
      webhookSecret: crypto.randomBytes(32).toString('hex'),
    }).returning();

    req.session.userId = user.id;
    setCsrfCookies(reply);

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const token = await issueEmailToken(user.id, 'verify_email');
    const verifyUrl = `${baseUrl}/verify-email/${token}`;
    let mailSent = false;
    try {
      await sendMail({ to: user.email, ...verifyEmailTemplate(verifyUrl) });
      mailSent = true;
    } catch (err) {
      req.log.error(err, 'Verifikations-E-Mail konnte nicht gesendet werden');
    }

    return reply.status(201).send({ id: user.id, email: user.email, mailSent });
  });

  app.post('/verify-email', {
    config: {
      rateLimit: {
        max: env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || !!process.env.CI ? 200 : 10,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({ statusCode: 429, title: 'Zu viele Anfragen. Bitte in 15 Minuten erneut versuchen.' }),
      },
    },
  }, async (req, reply) => {
    const { token } = req.body as { token?: string };
    if (!token) return reply.status(400).send({ title: 'Token fehlt.' });

    const result = await consumeEmailToken(token, 'verify_email');
    if (!result.ok) {
      const reasonTitle = result.reason === 'expired'
        ? 'Der Verifikationslink ist abgelaufen.'
        : result.reason === 'used'
        ? 'Der Verifikationslink wurde bereits verwendet.'
        : 'Ungültiger Verifikationslink.';
      return reply.status(400).send({ title: reasonTitle });
    }

    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, result.userId));

    req.session.userId = result.userId;
    setCsrfCookies(reply);
    return reply.status(200).send({ ok: true, userId: result.userId });
  });

  app.post('/resend-verification', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.emailVerifiedAt) return reply.status(400).send({ title: 'E-Mail ist bereits bestätigt.' });

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const token = await issueEmailToken(user.id, 'verify_email');
    const verifyUrl = `${baseUrl}/verify-email/${token}`;
    try {
      await sendMail({ to: user.email, ...verifyEmailTemplate(verifyUrl) });
    } catch (err) {
      req.log.error(err, 'Verifikations-E-Mail (resend) konnte nicht gesendet werden');
      return reply.status(503).send({ title: 'E-Mail konnte nicht gesendet werden. Bitte versuche es später erneut.' });
    }
    return reply.status(200).send({ ok: true });
  });

  app.post('/request-password-reset', {
    config: {
      rateLimit: {
        max: env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || !!process.env.CI ? 200 : 5,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({ statusCode: 429, title: 'Zu viele Anfragen. Bitte in 15 Minuten erneut versuchen.' }),
      },
    },
  }, async (req, reply) => {
    const { email } = req.body as { email?: string };
    if (!email) return reply.status(400).send({ title: 'E-Mail erforderlich.' });

    const cleanEmail = email.trim().toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, cleanEmail)).limit(1);
    if (user) {
      const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
      const token = await issueEmailToken(user.id, 'reset_password');
      const resetUrl = `${baseUrl}/reset-password/${token}`;
      try {
        await sendMail({ to: user.email, ...passwordResetTemplate(resetUrl) });
      } catch (err) {
        req.log.error(err, 'Passwort-Reset-E-Mail konnte nicht gesendet werden');
      }
    }

    return reply.status(200).send({ ok: true });
  });

  app.post('/reset-password', async (req, reply) => {
    const { token, password } = req.body as { token?: string; password?: string };
    if (!token || !password) return reply.status(400).send({ title: 'Token und Passwort erforderlich.' });
    const pwResult = passwordSchema.safeParse(password);
    if (!pwResult.success) {
      return reply.status(400).send({ title: pwResult.error.issues[0]?.message ?? 'Passwort entspricht nicht den Anforderungen.' });
    }
    if (isWeakPassword(password)) return reply.status(400).send({ title: 'Dieses Passwort ist zu häufig. Bitte wähle ein sichereres Passwort.' });

    const result = await consumeEmailToken(token, 'reset_password');
    if (!result.ok) {
      const reasonTitle = result.reason === 'expired'
        ? 'Der Link zum Zurücksetzen ist abgelaufen.'
        : result.reason === 'used'
        ? 'Dieser Link wurde bereits verwendet.'
        : 'Ungültiger Link.';
      return reply.status(400).send({ title: reasonTitle });
    }

    const passwordHash = await hashPassword(password);
    await req.session.destroy();
    await db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.userId, result.userId));
      await tx.update(users).set({ passwordHash }).where(eq(users.id, result.userId));
    });

    return reply.status(200).send({ ok: true });
  });

  app.post('/accept-invite', async (req, reply) => {
    const { token, password } = req.body as { token?: string; password?: string };
    if (!token || !password) return reply.status(400).send({ title: 'Token und Passwort erforderlich.' });
    const pwResult = passwordSchema.safeParse(password);
    if (!pwResult.success) {
      return reply.status(400).send({ title: pwResult.error.issues[0]?.message ?? 'Passwort entspricht nicht den Anforderungen.' });
    }
    if (isWeakPassword(password)) return reply.status(400).send({ title: 'Dieses Passwort ist zu häufig. Bitte wähle ein sichereres Passwort.' });

    const result = await consumeEmailToken(token, 'insurer_invite');
    if (!result.ok) {
      const reasonTitle = result.reason === 'expired'
        ? 'Die Einladung ist abgelaufen.'
        : result.reason === 'used'
        ? 'Diese Einladung wurde bereits verwendet.'
        : 'Ungültiger Einladungslink.';
      return reply.status(400).send({ title: reasonTitle });
    }

    const passwordHash = await hashPassword(password);
    const [user] = await db.update(users)
      .set({ passwordHash, emailVerifiedAt: new Date() })
      .where(eq(users.id, result.userId))
      .returning();

    if (user.organizationId) {
      await db.update(organizations).set({ status: 'active' }).where(eq(organizations.id, user.organizationId));
    }

    req.session.userId = user.id;
    setCsrfCookies(reply);
    return reply.status(200).send({ ok: true });
  });

  app.post('/login', {
    config: {
      rateLimit: {
        max: env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || !!process.env.CI ? 200 : 10,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({ statusCode: 429, title: 'Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen.' }),
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return reply.status(400).send({ title: 'E-Mail und Passwort erforderlich.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, cleanEmail)).limit(1);
    if (!user) return reply.status(401).send({ title: 'E-Mail oder Passwort falsch.' });

    const { ok, needsRehash } = await verifyPasswordWithRehash(user.passwordHash, password);
    if (!ok) return reply.status(401).send({ title: 'E-Mail oder Passwort falsch.' });

    if (needsRehash) {
      const freshHash = await hashPassword(password);
      await db.update(users).set({ passwordHash: freshHash }).where(eq(users.id, user.id));
    }

    req.session.userId = user.id;
    setCsrfCookies(reply);
    return reply.status(200).send({ ok: true });
  });

  app.post('/logout', async (req, reply) => {
    await req.session.destroy();
    clearCsrfCookies(reply);
    return reply.status(204).send();
  });

  app.post('/google/url', async (req, reply) => {
    const googleClientId = env.GOOGLE_FIT_CLIENT_ID ?? env.GOOGLE_HEALTH_CLIENT_ID;
    if (!googleClientId) return { url: null };
    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const redirectUri = (env.GOOGLE_REDIRECT_URI && env.GOOGLE_REDIRECT_URI.trim()) || `${baseUrl}/api/auth/google/callback`;
    const state = signAntiCsrfState();
    // Bind the state to this browser via an HTTP-only cookie. A bare signed
    // state (HMAC + expiry, no cookie) authenticates that the SERVER issued
    // it, but not that THIS caller was the one who received it — an attacker
    // can start their own flow, grab a valid state/code pair, and hand the
    // resulting callback URL to a victim (login CSRF, RFC 6749 §10.12). The
    // cookie is the actual binding to the requesting browser.
    reply.setCookie('google_oauth_state', state, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 600,
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', googleClientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('prompt', 'select_account');
    url.searchParams.set('state', state);
    return { url: url.toString() };
  });

  app.get('/google/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const googleClientId = env.GOOGLE_FIT_CLIENT_ID ?? env.GOOGLE_HEALTH_CLIENT_ID;
    const googleClientSecret = env.GOOGLE_FIT_CLIENT_SECRET ?? env.GOOGLE_HEALTH_CLIENT_SECRET;
    const cookieState = req.cookies.google_oauth_state;
    reply.clearCookie('google_oauth_state', { path: '/' });

    const stateBuf = state ? Buffer.from(state) : null;
    const cookieBuf = cookieState ? Buffer.from(cookieState) : null;
    const stateMatchesCookie = !!stateBuf && !!cookieBuf
      && stateBuf.length === cookieBuf.length
      && crypto.timingSafeEqual(stateBuf, cookieBuf);

    if (!googleClientId || !googleClientSecret || !code || !state || !stateMatchesCookie || !verifyAntiCsrfState(state)) {
      return reply.redirect('/login?error=google_auth_failed');
    }

    const baseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.hostname}`;
    const redirectUri = (env.GOOGLE_REDIRECT_URI && env.GOOGLE_REDIRECT_URI.trim()) || `${baseUrl}/api/auth/google/callback`;

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: googleClientId,
          client_secret: googleClientSecret,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error('Token exchange failed');
      const tokenData = await tokenRes.json() as { access_token: string };

      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userRes.ok) throw new Error('UserInfo request failed');
      const userInfo = await userRes.json() as { email?: string; name?: string };

      if (!userInfo.email) {
        return reply.redirect('/login?error=no_email');
      }

      const [existingUser] = await db.select().from(users).where(eq(users.email, userInfo.email)).limit(1);
      if (existingUser) {
        req.session.userId = existingUser.id;
        return reply.redirect('/dashboard');
      }

      return reply.redirect(`/register?googleEmail=${encodeURIComponent(userInfo.email)}&name=${encodeURIComponent(userInfo.name ?? '')}`);
    } catch (err) {
      req.log.error(err, 'Google Sign-In failed');
      return reply.redirect('/login?error=google_auth_failed');
    }
  });
}
