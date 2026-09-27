import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { db } from '../db/client.js';
import { organizations, users, partnerOffers, insurerRequests } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const INSURER_EMAIL = 'insurer-demo@longevity.app';
const INSURER_PASSWORD = 'insurer-longevity-2026';
const ORG_NAME = 'Demo Krankenkasse';

async function run() {
  console.log('Seeding demo insurer account…');

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, INSURER_EMAIL)).limit(1);
  if (existing.length > 0) {
    console.log('Demo insurer user already exists, skipping.');
    process.exit(0);
  }

  const { org, user } = await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({
      name: ORG_NAME,
      contactEmail: INSURER_EMAIL,
      status: 'active',
      joinCode: randomBytes(6).toString('hex'),
    }).returning();

    const passwordHash = await hash(INSURER_PASSWORD);
    const [user] = await tx.insert(users).values({
      email: INSURER_EMAIL,
      passwordHash,
      birthDate: '1985-06-01',
      sex: 'f',
      displayName: 'Demo Insurer Admin',
      role: 'insurer_admin',
      organizationId: org.id,
      emailVerifiedAt: new Date(),
    }).returning();

    await tx.insert(partnerOffers).values([
      {
        organizationId: org.id,
        partnerName: ORG_NAME,
        title: '10 % Beitragsnachlass',
        description: 'Testangebot der Demo-Krankenkasse für Mitglieder ab Band 60.',
        minBand: 60,
        valueLabel: '10 % Rabatt',
        isDemo: true,
        sortOrder: 1,
      },
      {
        organizationId: org.id,
        partnerName: ORG_NAME,
        title: 'Fitness-Zuschuss 50 €',
        description: 'Testangebot der Demo-Krankenkasse für Mitglieder ab Band 40.',
        minBand: 40,
        valueLabel: '50 € Zuschuss',
        isDemo: true,
        sortOrder: 2,
      },
    ]);

    return { org, user };
  });

  // Zusätzliche offene Anfrage anlegen, damit der /admin-Flow (Genehmigen/Ablehnen) testbar ist.
  const [pendingRequest] = await db.insert(insurerRequests).values({
    company: 'Neue Test-Krankenkasse GmbH',
    contactName: 'Erika Testkontakt',
    contactEmail: 'kontakt@neue-test-kasse.de',
    message: 'Testanfrage zum Ausprobieren des Admin-Genehmigungs-Flows.',
    status: 'pending',
  }).returning();

  console.log(`Organisation "${ORG_NAME}" angelegt (${org.id}).`);
  console.log(`Insurer-Admin erstellt: ${INSURER_EMAIL} / ${INSURER_PASSWORD} (user ${user.id})`);
  console.log('2 organisationseigene Partner-Angebote angelegt.');
  console.log(`Offene Insurer-Anfrage zum Testen angelegt (${pendingRequest.id}): "${pendingRequest.company}"`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
