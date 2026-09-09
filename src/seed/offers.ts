import { db } from '../db/client.js';
import { partnerOffers } from '../db/schema.js';

const DEMO_OFFERS = [
  {
    partnerName: 'Gothaer Krankenversicherung',
    title: '15 % Beitragsnachlass',
    description: 'Mitglieder mit einem Vitalitätsscore im Band 60+ erhalten bei Neuabschluss einer Zusatzkrankenversicherung 15 % Rabatt auf den Monatsbeitrag.',
    minBand: 60,
    valueLabel: '15 % Rabatt',
    isDemo: true,
    sortOrder: 1,
  },
  {
    partnerName: 'Techniker Krankenkasse',
    title: 'Bonus-Programm: 100 € Prämie',
    description: 'Erreiche Band 70 oder höher und erhalte einmalig 100 € als Gesundheitsprämie über das TK-Bonusprogramm.',
    minBand: 70,
    valueLabel: '100 € Prämie',
    isDemo: true,
    sortOrder: 2,
  },
  {
    partnerName: 'Allianz Lebensversicherung',
    title: 'Günstigerer Risikoaufschlag',
    description: 'Ein Vitalitätsscore im Band 50+ führt bei der Allianz zur Einstufung in die Niedrigrisikogruppe – mit entsprechend reduzierten Risikoprämien.',
    minBand: 50,
    valueLabel: 'Niedrigrisikogruppe',
    isDemo: true,
    sortOrder: 3,
  },
  {
    partnerName: 'Urban Sports Club',
    title: 'Kostenlose Probewoche',
    description: 'Mit einem nachgewiesenen Vitalitätsscore erhältst du Zugang zu einer kostenlosen 7-Tage-Testmitgliedschaft im Urban Sports Club.',
    minBand: 0,
    valueLabel: '7 Tage gratis',
    isDemo: true,
    sortOrder: 4,
  },
  {
    partnerName: 'Radeberger Mineralquellen',
    title: 'Jahresvorrat Mineralwasser',
    description: 'Mitglieder der Vitalitäts-Elite (Band 80+) erhalten einen Jahresvorrat Mineralwasser als Dankeschön für ihre Gesundheitsleistungen.',
    minBand: 80,
    valueLabel: 'Jahresvorrat',
    isDemo: true,
    sortOrder: 5,
  },
];

async function run() {
  console.log('Seeding partner_offers…');
  await db.delete(partnerOffers);
  await db.insert(partnerOffers).values(DEMO_OFFERS);
  console.log(`Inserted ${DEMO_OFFERS.length} partner offers.`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
