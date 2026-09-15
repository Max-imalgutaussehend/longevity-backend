import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { db } from '../db/client.js';
import { organizations, users, emailTokens } from '../db/schema.js';
import { sendMail } from '../lib/mail.js';
import { insurerInviteTemplate } from '../lib/emailTemplates.js';
import { env } from '../env.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function main() {
  const [orgName, contactEmail] = process.argv.slice(2);
  if (!orgName || !contactEmail) {
    console.error('Usage: pnpm tsx src/seed/inviteInsurer.ts "<Kassenname>" <kontakt@email.de>');
    process.exit(1);
  }

  const { org, user, token } = await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({
      name: orgName,
      contactEmail,
      status: 'pending',
      joinCode: randomBytes(6).toString('hex'),
    }).returning();

    const unusablePasswordHash = await hash(randomBytes(32).toString('base64url'));
    const [user] = await tx.insert(users).values({
      email: contactEmail,
      passwordHash: unusablePasswordHash,
      birthDate: '1970-01-01',
      sex: 'm',
      role: 'insurer_admin',
      organizationId: org.id,
    }).returning();

    const id = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await tx.insert(emailTokens).values({ id, userId: user.id, purpose: 'insurer_invite', expiresAt });

    return { org, user, token: id };
  });

  const baseUrl = env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
  const inviteUrl = `${baseUrl}/insurer-invite/${token}`;

  await sendMail({ to: contactEmail, ...insurerInviteTemplate(orgName, inviteUrl) });

  console.log(`Organisation "${orgName}" angelegt (${org.id}).`);
  console.log(`Insurer-Admin ${contactEmail} angelegt (${user.id}), Einladung verschickt.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Einladung fehlgeschlagen:', err);
  process.exit(1);
});
