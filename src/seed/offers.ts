import { db } from '../db/client.js';
import { partnerOffers, organizations } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const DEMO_OFFERS: (typeof partnerOffers.$inferInsert)[] = [
  {
    partnerName: 'Urban Sports Club',
    title: 'Kostenlose Probewoche',
    description: 'Mit einem nachgewiesenen Vitalitätsscore erhältst du Zugang zu einer kostenlosen 7-Tage-Testmitgliedschaft im Urban Sports Club.',
    minBand: 0,
    valueLabel: '7 Tage gratis',
    benefitType: 'voucher',
    voucherDelivery: 'code_pool',
    voucherCode: 'LONGEVITY-USC-7D',
    partnerUrl: 'https://urbansportsclub.com',
    membersOnly: false,
    isDemo: true,
    sortOrder: 3,
  },
  {
    partnerName: 'Allianz Lebensversicherung',
    title: 'Günstigerer Risikoaufschlag',
    description: 'Ein Vitalitätsscore im Band 50+ führt bei der Allianz zur Einstufung in die Niedrigrisikogruppe – mit entsprechend reduzierten Risikoprämien.',
    minBand: 50,
    valueLabel: 'Niedrigrisikogruppe',
    benefitType: 'certificate',
    membersOnly: false,
    isDemo: true,
    sortOrder: 4,
  },
  {
    partnerName: 'Gothaer Krankenversicherung',
    title: '15 % Beitragsnachlass',
    description: 'Mitglieder mit einem Vitalitätsscore im Band 60+ erhalten bei Neuabschluss einer Zusatzkrankenversicherung 15 % Rabatt auf den Monatsbeitrag.',
    minBand: 60,
    valueLabel: '15 % Rabatt',
    benefitType: 'certificate',
    membersOnly: false,
    isDemo: true,
    sortOrder: 5,
  },
  {
    partnerName: 'Techniker Krankenkasse',
    title: 'Bonus-Programm: 100 € Prämie',
    description: 'Erreiche Band 70 oder höher und erhalte einmalig 100 € als Gesundheitsprämie über das TK-Bonusprogramm (§ 65a SGB V).',
    minBand: 70,
    valueLabel: '100 € Prämie',
    benefitType: 'certificate',
    membersOnly: false,
    isDemo: true,
    sortOrder: 6,
  },
  {
    partnerName: 'Radeberger Mineralquellen',
    title: 'Jahresvorrat Mineralwasser',
    description: 'Mitglieder der Vitalitäts-Elite (Band 80+) erhalten einen Jahresvorrat Mineralwasser als Dankeschön für ihre Gesundheitsleistungen.',
    minBand: 80,
    valueLabel: 'Jahresvorrat',
    benefitType: 'voucher',
    voucherDelivery: 'code_pool',
    voucherCode: 'VITAL-ELITE-WATER',
    membersOnly: false,
    isDemo: true,
    sortOrder: 7,
  },
];

async function run() {
  console.log('Seeding partner_offers…');
  await db.delete(partnerOffers);

  const [demoOrg] = await db.select().from(organizations).where(eq(organizations.name, 'Demo Krankenkasse')).limit(1);

  const offersToInsert: (typeof partnerOffers.$inferInsert)[] = [
    ...(demoOrg ? [
      {
        organizationId: demoOrg.id,
        partnerName: 'Demo Krankenkasse',
        title: 'Fitness-Zuschuss 50 €',
        description: 'Testangebot der Demo-Krankenkasse für Mitglieder ab Band 40 ohne Mindesthaltedauer.',
        minBand: 40,
        minMonths: null,
        valueLabel: '50 € Zuschuss',
        benefitType: 'payout' as const,
        membersOnly: true,
        isDemo: true,
        sortOrder: 1,
      },
      {
        organizationId: demoOrg.id,
        partnerName: 'Demo Krankenkasse',
        title: '15 % Beitragsnachlass (ab 3 Monaten)',
        description: 'Testangebot der Demo-Krankenkasse für Mitglieder ab Band 60 nach 3 Monaten Haltedauer.',
        minBand: 60,
        minMonths: 3,
        valueLabel: '15 % Rabatt',
        benefitType: 'payout' as const,
        membersOnly: true,
        isDemo: true,
        sortOrder: 2,
      },
    ] : []),
    ...DEMO_OFFERS,
  ];

  await db.insert(partnerOffers).values(offersToInsert);
  console.log(`Inserted ${offersToInsert.length} partner offers.`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
