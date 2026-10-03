import crypto from 'node:crypto';
import { db } from '../db/client.js';
import {
  organizations,
  users,
  sources,
  samples,
  scoreSnapshots,
  partnerOffers,
  insurerRequests,
} from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import { hashKvnr } from '../lib/kvnr.js';
import { computeScore } from '../score/index.js';
import type { Sample, SourceKind } from '../score/types.js';

// Deterministic PRNG for reproducibility
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateValidKvnr(letter: string, middle8: string): string {
  const cleanLetter = letter.toUpperCase();
  const letterNum = (cleanLetter.charCodeAt(0) - 64).toString().padStart(2, '0');
  const digits = (letterNum + middle8).split('').map(Number);
  const weights = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const prod = digits[i] * weights[i];
    sum += prod >= 10 ? Math.floor(prod / 10) + (prod % 10) : prod;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return `${cleanLetter}${middle8}${checkDigit}`;
}

export async function run() {
  console.log('🚀 Starte Erstellung des vollständigen Testdaten-Sets…\n');

  const now = new Date();
  const defaultPassword = 'demo-longevity-2026';
  const sharedPasswordHash = await hashPassword(defaultPassword);
  const insurerPasswordHash = await hashPassword('insurer-longevity-2026');
  const adminPasswordHash = await hashPassword('admin-longevity-2026');

  // =========================================================================
  // 1. KRANKENKASSEN (ORGANISATIONS)
  // =========================================================================
  console.log('📦 1. Erstelle Krankenkassen / Organisationen…');

  const ORGS_DATA = [
    {
      name: 'Techniker Krankenkasse (TK)',
      contactEmail: 'partner@tk.de',
      status: 'active',
      joinCode: 'TK-2026',
    },
    {
      name: 'Barmer',
      contactEmail: 'partner@barmer.de',
      status: 'active',
      joinCode: 'BAR-2026',
    },
    {
      name: 'AOK Baden-Württemberg',
      contactEmail: 'partner@aok-bw.de',
      status: 'active',
      joinCode: 'AOK-2026',
    },
    {
      name: 'Ottonova Krankenversicherung',
      contactEmail: 'partner@ottonova.de',
      status: 'active',
      joinCode: 'OTTO-2026',
    },
    {
      name: 'Demo Krankenkasse',
      contactEmail: 'insurer-demo@longevity.app',
      status: 'active',
      joinCode: 'DEMO-2026',
    },
  ];

  const orgMap = new Map<string, string>(); // name -> id

  for (const orgData of ORGS_DATA) {
    const existing = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.joinCode, orgData.joinCode))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(organizations)
        .set({ name: orgData.name, contactEmail: orgData.contactEmail, status: orgData.status })
        .where(eq(organizations.id, existing[0].id));
      orgMap.set(orgData.name, existing[0].id);
    } else {
      const [inserted] = await db.insert(organizations).values(orgData).returning();
      orgMap.set(orgData.name, inserted.id);
    }
  }
  console.log(`   ✓ ${ORGS_DATA.length} Krankenkassen bereitgestellt.`);

  // =========================================================================
  // 2. KRANKENKASSEN-ANFRAGEN (FÜR PLATFORM ADMIN /admin)
  // =========================================================================
  console.log('📋 2. Erstelle Krankenkassen-Anfragen (für Admin-Portal)…');

  // Vorherige Test-Anfragen bereinigen
  await db.delete(insurerRequests);

  await db.insert(insurerRequests).values([
    {
      company: 'DAK-Gesundheit',
      contactName: 'Dr. Martin Weber',
      contactEmail: 'm.weber@dak.de',
      message: 'Wir möchten unser digitales Bonusprogramm anbinden und Versicherten mit hohem Vitalitätsscore Prämien anbieten.',
      status: 'pending',
    },
    {
      company: 'Allianz Private Krankenversicherung',
      contactName: 'Sarah Lindner',
      contactEmail: 's.lindner@allianz.de',
      message: 'Pilotprojekt für risikoadjustierte Vitalitäts-Tarife und Wearable-Integration.',
      status: 'pending',
    },
    {
      company: 'IKK classic',
      contactName: 'Thomas Müller',
      contactEmail: 't.mueller@ikk-classic.de',
      message: 'Interesse an digitaler Schnittstelle für Präventionskurse und Vorsorge-Nachweise.',
      status: 'pending',
    },
    {
      company: 'Signal Iduna Krankenversicherung',
      contactName: 'Janina Schuster',
      contactEmail: 'j.schuster@signal-iduna.de',
      message: 'Offizielle Partnerschaftsanfrage.',
      status: 'approved',
      decidedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
    },
  ]);
  console.log('   ✓ 4 Insurer-Anfragen angelegt (3 pending, 1 approved).');

  // =========================================================================
  // 3. VORTEILE (PARTNER OFFERS)
  // =========================================================================
  console.log('🎁 3. Erstelle Partner-Angebote & Vorteile…');

  await db.delete(partnerOffers);

  const tkId = orgMap.get('Techniker Krankenkasse (TK)');
  const barmerId = orgMap.get('Barmer');
  const aokId = orgMap.get('AOK Baden-Württemberg');
  const ottonovaId = orgMap.get('Ottonova Krankenversicherung');
  const demoOrgId = orgMap.get('Demo Krankenkasse');

  const OFFERS_DATA = [
    // --- Allgemein (Plattformweit, kein spezifischer Org-Zwang) ---
    {
      organizationId: null,
      partnerName: 'Urban Sports Club',
      title: 'Kostenlose Probewoche',
      description: 'Mit einem nachgewiesenen Vitalitätsscore erhältst du Zugang zu einer kostenlosen 7-Tage-Testmitgliedschaft im Urban Sports Club (über 10.000 Partnerstudios).',
      minBand: 0,
      minMonths: null,
      valueLabel: '7 Tage gratis',
      benefitType: 'voucher' as const,
      voucherDelivery: 'code_pool' as const,
      voucherCode: 'LONGEVITY-USC-7D',
      partnerUrl: 'https://urbansportsclub.com',
      membersOnly: false,
      sortOrder: 1,
    },
    {
      organizationId: null,
      partnerName: 'Sunday Natural',
      title: '15 % Rabatt auf Longevity Supplements',
      description: 'Erhalte 15 % Rabatt auf hochwertige Vitamine, Omega-3, Magnesium und pflanzliche Extrakte ab Band 40.',
      minBand: 40,
      minMonths: null,
      valueLabel: '15 % Rabatt',
      benefitType: 'voucher' as const,
      voucherDelivery: 'code_pool' as const,
      voucherCode: 'SUNDAY-LONGEVITY-15',
      partnerUrl: 'https://www.sunday.de',
      membersOnly: false,
      sortOrder: 2,
    },
    {
      organizationId: null,
      partnerName: 'Allianz Lebensversicherung',
      title: 'Einstufung in Niedrigrisikogruppe',
      description: 'Ein Vitalitätsscore im Band 50+ führt bei der Allianz zur Einstufung in die Niedrigrisikogruppe – mit entsprechend reduzierten Risikoprämien bei Lebens- und Berufsunfähigkeitsversicherungen.',
      minBand: 50,
      minMonths: null,
      valueLabel: 'Niedrigrisiko-Tarif',
      benefitType: 'certificate' as const,
      membersOnly: false,
      sortOrder: 3,
    },
    {
      organizationId: null,
      partnerName: 'Gothaer Krankenversicherung',
      title: '15 % Beitragsnachlass Zusatzversicherung',
      description: 'Mitglieder mit einem Vitalitätsscore im Band 60+ erhalten bei Neuabschluss einer Zusatzkrankenversicherung 15 % Rabatt auf den Monatsbeitrag.',
      minBand: 60,
      minMonths: 1,
      valueLabel: '15 % Rabatt',
      benefitType: 'certificate' as const,
      membersOnly: false,
      sortOrder: 4,
    },
    {
      organizationId: null,
      partnerName: 'Radeberger Mineralquellen',
      title: 'Jahresvorrat Mineralwasser & Elektrolyte',
      description: 'Mitglieder der Vitalitäts-Elite (Band 80+) erhalten einen Jahresvorrat Premium-Mineralwasser frei Haus geliefert.',
      minBand: 80,
      minMonths: null,
      valueLabel: 'Jahresvorrat',
      benefitType: 'voucher' as const,
      voucherDelivery: 'code_pool' as const,
      voucherCode: 'RADEBERGER-ELITE',
      membersOnly: false,
      sortOrder: 5,
    },

    // --- Techniker Krankenkasse (TK) ---
    {
      organizationId: tkId,
      partnerName: 'Techniker Krankenkasse (TK)',
      title: 'Erweiterter Longevity-Vorsorgecheck',
      description: 'Kostenloser jährlicher Biomarker- und Blutbild-Checkup (Lipidprofil, HbA1c, hsCRP) beim Partnerlabor exklusiv für TK-Versicherte ab Band 60.',
      minBand: 60,
      minMonths: null,
      valueLabel: 'Kostenloser Checkup',
      sortOrder: 10,
    },
    {
      organizationId: tkId,
      partnerName: 'Techniker Krankenkasse (TK)',
      title: 'TK-Bonusprogramm: 100 € Barprämie',
      description: 'Erreiche Band 70 oder höher und halte diesen Score für mindestens einen Monat, um 100 € direkte Barprämie über das Bonusprogramm auszuzahlen.',
      minBand: 70,
      minMonths: 1,
      valueLabel: '100 € Barprämie',
      sortOrder: 11,
    },
    {
      organizationId: tkId,
      partnerName: 'Techniker Krankenkasse (TK)',
      title: 'TK Excellence: Jährliches Kardio-MRT',
      description: 'Ganzheitliche Kardio- und Gefäßdiagnostik in spezialisierten Spitzenzentren für Versicherte der Vitalitäts-Elite (Band 80+).',
      minBand: 80,
      minMonths: 2,
      valueLabel: 'Premium Kardio-MRT',
      sortOrder: 12,
    },

    // --- Barmer ---
    {
      organizationId: barmerId,
      partnerName: 'Barmer',
      title: 'Smartwatch- & Wearable-Zuschuss (50 €)',
      description: 'Zuschuss von bis zu 50 € beim Kauf eines zertifizierten Trackers (Apple Watch, Oura Ring, Garmin oder Whoop) ab Band 40.',
      minBand: 40,
      minMonths: null,
      valueLabel: '50 € Zuschuss',
      sortOrder: 20,
    },
    {
      organizationId: barmerId,
      partnerName: 'Barmer',
      title: 'Barmer Vital-Cashback 80 €',
      description: 'Jährliche Cashback-Prämie für Barmer-Versicherte, die mindestens zwei Monate im Band 70+ aktiv sind.',
      minBand: 70,
      minMonths: 2,
      valueLabel: '80 € Cashback',
      sortOrder: 21,
    },

    // --- AOK Baden-Württemberg ---
    {
      organizationId: aokId,
      partnerName: 'AOK Baden-Württemberg',
      title: 'Kostenlose professionelle Zahnreinigung',
      description: 'Erhalte 1x jährlich eine professionelle Zahnreinigung (PZR) bei teilnehmenden Zahnarztpraxen ab Band 50.',
      minBand: 50,
      minMonths: null,
      valueLabel: 'Kostenlose PZR',
      sortOrder: 30,
    },
    {
      organizationId: aokId,
      partnerName: 'AOK Baden-Württemberg',
      title: 'Präventionsurlaub Aktiv-Zuschuss (150 €)',
      description: '150 € Zuschuss für qualitätsgesicherte Gesundheits- und Aktivwochenenden in Baden-Württemberg ab Band 70.',
      minBand: 70,
      minMonths: 1,
      valueLabel: '150 € Zuschuss',
      sortOrder: 31,
    },

    // --- Ottonova ---
    {
      organizationId: ottonovaId,
      partnerName: 'Ottonova Krankenversicherung',
      title: '1 Monatsbeitrag Cashback pro Jahr',
      description: 'Ottonova erstattet Versicherten im Band 70+, die ihren Status für mindestens 3 Monate halten, einen vollen Monatsbeitrag zurück.',
      minBand: 70,
      minMonths: 3,
      valueLabel: '1 Monatsbeitrag frei',
      sortOrder: 40,
    },
    {
      organizationId: ottonovaId,
      partnerName: 'Ottonova Krankenversicherung',
      title: '25 % Exklusiv-Rabatt Vollversicherung',
      description: 'Höchste Rabattstufe auf die monatlichen Krankenversicherungsbeiträge für Mitglieder der Vitalitäts-Elite (Band 80+).',
      minBand: 80,
      minMonths: 3,
      valueLabel: '25 % Rabatt',
      sortOrder: 41,
    },

    // --- Demo Krankenkasse ---
    {
      organizationId: demoOrgId,
      partnerName: 'Demo Krankenkasse',
      title: '10 % Beitragsnachlass auf Wahltarife',
      description: 'Testangebot der Demo-Krankenkasse für verifizierte Mitglieder ab Band 60.',
      minBand: 60,
      minMonths: 1,
      valueLabel: '10 % Rabatt',
      sortOrder: 50,
    },
    {
      organizationId: demoOrgId,
      partnerName: 'Demo Krankenkasse',
      title: 'Fitness-Zuschuss 50 €',
      description: 'Jährlicher Zuschuss für Fitnessstudios und Sportvereine ab Band 40.',
      minBand: 40,
      minMonths: null,
      valueLabel: '50 € Zuschuss',
      sortOrder: 51,
    },
  ];

  await db.insert(partnerOffers).values(
    OFFERS_DATA.map((o) => ({
      organizationId: o.organizationId,
      partnerName: o.partnerName,
      title: o.title,
      description: o.description,
      minBand: o.minBand,
      minMonths: o.minMonths,
      valueLabel: o.valueLabel,
      benefitType: (o as { benefitType?: 'payout' | 'voucher' | 'certificate' }).benefitType ?? 'payout',
      voucherDelivery: (o as { voucherDelivery?: 'code_pool' | 'email' }).voucherDelivery ?? 'email',
      voucherCode: (o as { voucherCode?: string }).voucherCode ?? null,
      partnerUrl: (o as { partnerUrl?: string }).partnerUrl ?? null,
      membersOnly: (o as { membersOnly?: boolean }).membersOnly ?? Boolean(o.organizationId),
      isDemo: true,
      sortOrder: o.sortOrder,
    }))
  );
  console.log(`   ✓ ${OFFERS_DATA.length} Partner-Angebote angelegt.`);

  // =========================================================================
  // 4. ADMIN- & INSURER-USER
  // =========================================================================
  console.log('👤 4. Erstelle Admin- und Krankenkassen-Mitarbeiter-Accounts…');

  const STAFF_USERS = [
    {
      email: 'admin@longevity.app',
      displayName: 'Platform Admin',
      role: 'platform_admin',
      orgId: null,
      birthDate: '1990-01-01',
      sex: 'm',
      passwordHash: adminPasswordHash,
    },
    {
      email: 'tk-admin@longevity.app',
      displayName: 'TK Versicherten-Management',
      role: 'insurer_admin',
      orgId: tkId,
      birthDate: '1985-04-12',
      sex: 'm',
      passwordHash: sharedPasswordHash,
    },
    {
      email: 'barmer-admin@longevity.app',
      displayName: 'Barmer Präventions-Team',
      role: 'insurer_admin',
      orgId: barmerId,
      birthDate: '1988-09-23',
      sex: 'f',
      passwordHash: sharedPasswordHash,
    },
    {
      email: 'aok-admin@longevity.app',
      displayName: 'AOK Vital-Beauftragte',
      role: 'insurer_admin',
      orgId: aokId,
      birthDate: '1982-12-05',
      sex: 'f',
      passwordHash: sharedPasswordHash,
    },
    {
      email: 'ottonova-admin@longevity.app',
      displayName: 'Ottonova Underwriting & Health',
      role: 'insurer_admin',
      orgId: ottonovaId,
      birthDate: '1991-07-19',
      sex: 'm',
      passwordHash: sharedPasswordHash,
    },
    {
      email: 'insurer-demo@longevity.app',
      displayName: 'Demo Insurer Admin',
      role: 'insurer_admin',
      orgId: demoOrgId,
      birthDate: '1985-06-01',
      sex: 'f',
      passwordHash: insurerPasswordHash,
    },
  ];

  for (const staff of STAFF_USERS) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, staff.email))
      .limit(1);

    const userPasswordHash = staff.passwordHash ?? sharedPasswordHash;

    if (existing.length > 0) {
      await db
        .update(users)
        .set({
          passwordHash: userPasswordHash,
          displayName: staff.displayName,
          role: staff.role,
          organizationId: staff.orgId,
          emailVerifiedAt: new Date(),
        })
        .where(eq(users.id, existing[0].id));
    } else {
      await db.insert(users).values({
        email: staff.email,
        passwordHash: userPasswordHash,
        displayName: staff.displayName,
        role: staff.role,
        organizationId: staff.orgId,
        birthDate: staff.birthDate,
        sex: staff.sex,
        emailVerifiedAt: new Date(),
        webhookSecret: crypto.randomBytes(32).toString('hex'),
      });
    }
  }
  console.log(`   ✓ ${STAFF_USERS.length} Admin-/Insurer-Accounts eingerichtet.`);

  // =========================================================================
  // 5. B2C TESTUSER MIT REALISTISCHEN BIOMARKERN & HISTORIE
  // =========================================================================
  console.log('🧬 5. Erstelle B2C Testuser mit Gesundheitsdaten & Score-Verläufen…');

  interface UserArchetype {
    email: string;
    displayName: string;
    birthDate: string;
    sex: 'm' | 'f';
    orgName: string;
    kvnrLetter: string;
    kvnrDigits: string;
    seed: number;
    days: number;
    targetScoreBand: string;
    description: string;
    biomarkers: {
      vo2max: number;
      restingHr: number;
      hrvRmssd: number;
      sleepDuration: number;
      sleepConsistency: number;
      zone2Minutes: number;
      steps: number;
      strengthSessions: number;
      ldl: number;
      hdl: number;
      hba1c: number;
      systolicBp: number;
      waist: number;
      smoking: number; // 0=never, 1=former>1y, 2=former<1y, 3=current
      alcoholUnits: number;
      hscrp: number;
    };
  }

  const B2C_USERS: UserArchetype[] = [
    // 1. Max Mustermann (Demo-User, TK, Band 70, solider Longevity-Pionier)
    {
      email: 'demo@longevity.app',
      displayName: 'Max Mustermann',
      birthDate: '1997-03-14',
      sex: 'm',
      orgName: 'Techniker Krankenkasse (TK)',
      kvnrLetter: 'T',
      kvnrDigits: '12345678',
      seed: 20260909,
      days: 90,
      targetScoreBand: 'Band 70 (~72 Punkte)',
      description: 'Ausgewogener Longevity-Enthusiast mit Oura & Apple Health, qualifiziert für Band 70 Prämien.',
      biomarkers: {
        vo2max: 54,
        restingHr: 54,
        hrvRmssd: 68,
        sleepDuration: 7.5,
        sleepConsistency: 22,
        zone2Minutes: 160,
        steps: 10500,
        strengthSessions: 2.5,
        ldl: 92,
        hdl: 60,
        hba1c: 5.0,
        systolicBp: 116,
        waist: 82,
        smoking: 0,
        alcoholUnits: 3,
        hscrp: 0.9,
      },
    },

    // 2. Alexander Pro (Athlete / Spitzenreiter, Ottonova, Band 80+)
    {
      email: 'athlete@longevity.app',
      displayName: 'Alexander Pro',
      birthDate: '1992-05-18',
      sex: 'm',
      orgName: 'Ottonova Krankenversicherung',
      kvnrLetter: 'O',
      kvnrDigits: '88776655',
      seed: 19920518,
      days: 90,
      targetScoreBand: 'Band 80+ (~86 Punkte)',
      description: 'Vitalitäts-Elite! Spitzen-VO2max, niedriger Ruhepuls, schaltet alle Top-Angebote frei.',
      biomarkers: {
        vo2max: 60,
        restingHr: 45,
        hrvRmssd: 85,
        sleepDuration: 8.2,
        sleepConsistency: 12,
        zone2Minutes: 240,
        steps: 14000,
        strengthSessions: 4.0,
        ldl: 75,
        hdl: 72,
        hba1c: 4.7,
        systolicBp: 110,
        waist: 76,
        smoking: 0,
        alcoholUnits: 1,
        hscrp: 0.3,
      },
    },

    // 3. Julia Starter (Motivierte Einsteigerin, Barmer, Band 50)
    {
      email: 'starter@longevity.app',
      displayName: 'Julia Starter',
      birthDate: '1995-11-20',
      sex: 'f',
      orgName: 'Barmer',
      kvnrLetter: 'B',
      kvnrDigits: '44556677',
      seed: 19951120,
      days: 60,
      targetScoreBand: 'Band 50 (~54 Punkte)',
      description: 'Solider Start: Band 40 & 50 freigeschaltet, sieht Punkte-Lücke & Hebel zu Band 60/70.',
      biomarkers: {
        vo2max: 38,
        restingHr: 66,
        hrvRmssd: 46,
        sleepDuration: 6.9,
        sleepConsistency: 45,
        zone2Minutes: 70,
        steps: 6800,
        strengthSessions: 1.0,
        ldl: 118,
        hdl: 52,
        hba1c: 5.3,
        systolicBp: 122,
        waist: 74,
        smoking: 0,
        alcoholUnits: 4,
        hscrp: 1.5,
      },
    },

    // 4. Markus Sedentary (Hohes Potenzial / Raucher, AOK, Band 30)
    {
      email: 'lowscore@longevity.app',
      displayName: 'Markus Sedentary',
      birthDate: '1984-08-10',
      sex: 'm',
      orgName: 'AOK Baden-Württemberg',
      kvnrLetter: 'A',
      kvnrDigits: '33221100',
      seed: 19840810,
      days: 45,
      targetScoreBand: 'Band 30 (~36 Punkte)',
      description: 'Ideal zum Testen der Hebel-Funktion (Rauchstopp +12 Pkt, Zone 2 Cardio +8 Pkt).',
      biomarkers: {
        vo2max: 29,
        restingHr: 78,
        hrvRmssd: 26,
        sleepDuration: 5.8,
        sleepConsistency: 65,
        zone2Minutes: 20,
        steps: 3200,
        strengthSessions: 0.0,
        ldl: 152,
        hdl: 39,
        hba1c: 5.9,
        systolicBp: 138,
        waist: 98,
        smoking: 3, // Aktiver Raucher
        alcoholUnits: 12,
        hscrp: 3.5,
      },
    },

    // 5. Elisabeth Vital (Aktive Seniorin, TK, Band 60)
    {
      email: 'senior@longevity.app',
      displayName: 'Elisabeth Vital',
      birthDate: '1963-02-15',
      sex: 'f',
      orgName: 'Techniker Krankenkasse (TK)',
      kvnrLetter: 'E',
      kvnrDigits: '66778899',
      seed: 19630215,
      days: 60,
      targetScoreBand: 'Band 60 (~65 Punkte)',
      description: 'Biologisches Alter 7 Jahre unter dem chronologischen Alter, sehr konstante Werte.',
      biomarkers: {
        vo2max: 35,
        restingHr: 58,
        hrvRmssd: 42,
        sleepDuration: 7.6,
        sleepConsistency: 18,
        zone2Minutes: 130,
        steps: 8800,
        strengthSessions: 2.0,
        ldl: 104,
        hdl: 62,
        hba1c: 5.2,
        systolicBp: 124,
        waist: 77,
        smoking: 0,
        alcoholUnits: 2,
        hscrp: 1.1,
      },
    },
  ];

  for (const profile of B2C_USERS) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, profile.email))
      .limit(1);

    if (existing.length > 0) {
      await db.delete(users).where(eq(users.id, existing[0].id));
    }

    const assignedOrgId = orgMap.get(profile.orgName) || null;
    const kvnr = generateValidKvnr(profile.kvnrLetter, profile.kvnrDigits);
    const kvnrHash = hashKvnr(kvnr);

    const [user] = await db
      .insert(users)
      .values({
        email: profile.email,
        passwordHash: sharedPasswordHash,
        birthDate: profile.birthDate,
        sex: profile.sex,
        displayName: profile.displayName,
        role: 'b2c',
        organizationId: assignedOrgId,
        organizationVerifiedAt: assignedOrgId ? new Date() : null,
        kvnrHash,
        emailVerifiedAt: new Date(),
        healthDataConsentAt: new Date(),
        healthDataConsentVersion: '1.0',
        webhookSecret: crypto.randomBytes(32).toString('hex'),
      })
      .returning();

    // 4 Datenquellen für jeden User
    const [appleHealthSrc] = await db
      .insert(sources)
      .values({
        userId: user.id,
        kind: 'apple_health',
        adapter: 'mock',
        enabled: true,
        lastSyncAt: now,
      })
      .returning();

    const [ouraSrc] = await db
      .insert(sources)
      .values({
        userId: user.id,
        kind: 'oura',
        adapter: 'mock',
        enabled: true,
        lastSyncAt: now,
      })
      .returning();

    const [labSrc] = await db
      .insert(sources)
      .values({
        userId: user.id,
        kind: 'lab',
        adapter: 'manual',
        enabled: true,
        lastSyncAt: now,
      })
      .returning();

    const [questionnaireSrc] = await db
      .insert(sources)
      .values({
        userId: user.id,
        kind: 'questionnaire',
        adapter: 'manual',
        enabled: true,
        lastSyncAt: now,
      })
      .returning();

    const sourceMap: Record<SourceKind, string> = {
      apple_health: appleHealthSrc.id,
      oura: ouraSrc.id,
      lab: labSrc.id,
      questionnaire: questionnaireSrc.id,
      withings: appleHealthSrc.id,
      google_fit: appleHealthSrc.id,
      strava: appleHealthSrc.id,
      health_auto_export: appleHealthSrc.id,
    };

    // Historie & Samples generieren mit AR(1) Rauschen
    const rand = mulberry32(profile.seed);
    const userSamplesList: Sample[] = [];
    const b = profile.biomarkers;

    // Zeitreihe für Wearable-Metriken (täglich)
    for (let d = profile.days - 1; d >= 0; d--) {
      const sampleDate = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      const iso = sampleDate.toISOString();

      // Täglich Schritte & Schlaf
      const dailySteps = Math.max(800, Math.round(b.steps + (rand() - 0.5) * 1800));
      const dailySleep = Math.max(4, Math.round((b.sleepDuration + (rand() - 0.5) * 1.2) * 10) / 10);
      const dailyRestingHr = Math.max(38, Math.round(b.restingHr + (rand() - 0.5) * 4));
      const dailyHrv = Math.max(15, Math.round(b.hrvRmssd + (rand() - 0.5) * 10));

      userSamplesList.push(
        { metric: 'steps', value: dailySteps, unit: 'steps/day', measuredAt: iso, sourceKind: 'apple_health' },
        { metric: 'sleep_duration', value: dailySleep, unit: 'h', measuredAt: iso, sourceKind: 'oura' },
        { metric: 'resting_hr', value: dailyRestingHr, unit: 'bpm', measuredAt: iso, sourceKind: 'oura' },
        { metric: 'hrv_rmssd', value: dailyHrv, unit: 'ms', measuredAt: iso, sourceKind: 'oura' }
      );

      // Wöchentliche Aggregate (alle 7 Tage)
      if (d % 7 === 0) {
        userSamplesList.push(
          { metric: 'vo2max', value: b.vo2max + Math.round((rand() - 0.5) * 2), unit: 'ml/kg/min', measuredAt: iso, sourceKind: 'apple_health' },
          { metric: 'zone2_minutes', value: Math.max(0, b.zone2Minutes + Math.round((rand() - 0.5) * 30)), unit: 'min/week', measuredAt: iso, sourceKind: 'apple_health' },
          { metric: 'strength_sessions', value: b.strengthSessions, unit: '/week', measuredAt: iso, sourceKind: 'apple_health' },
          { metric: 'sleep_consistency', value: b.sleepConsistency, unit: 'min', measuredAt: iso, sourceKind: 'oura' }
        );
      }
    }

    // Labormessungen (vor ca. 30 Tagen)
    const labDate = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString();
    userSamplesList.push(
      { metric: 'ldl', value: b.ldl, unit: 'mg/dL', measuredAt: labDate, sourceKind: 'lab' },
      { metric: 'hdl', value: b.hdl, unit: 'mg/dL', measuredAt: labDate, sourceKind: 'lab' },
      { metric: 'hba1c', value: b.hba1c, unit: '%', measuredAt: labDate, sourceKind: 'lab' },
      { metric: 'systolic_bp', value: b.systolicBp, unit: 'mmHg', measuredAt: labDate, sourceKind: 'lab' },
      { metric: 'waist', value: b.waist, unit: 'cm', measuredAt: labDate, sourceKind: 'lab' },
      { metric: 'hscrp', value: b.hscrp, unit: 'mg/L', measuredAt: labDate, sourceKind: 'lab' },
      { metric: 'smoking', value: b.smoking, unit: 'category', measuredAt: labDate, sourceKind: 'questionnaire' },
      { metric: 'alcohol_units', value: b.alcoholUnits, unit: 'units/week', measuredAt: labDate, sourceKind: 'questionnaire' }
    );

    // Samples in Chunks in die DB einfügen
    const dbSampleRows = userSamplesList.map((s) => ({
      userId: user.id,
      sourceId: sourceMap[s.sourceKind] || appleHealthSrc.id,
      metric: s.metric,
      value: s.value,
      unit: s.unit,
      measuredAt: new Date(s.measuredAt),
    }));

    const CHUNK_SIZE = 100;
    for (let i = 0; i < dbSampleRows.length; i += CHUNK_SIZE) {
      await db.insert(samples).values(dbSampleRows.slice(i, i + CHUNK_SIZE));
    }

    // Historische Score-Snapshots für den Graphen generieren (letzte 30 Tage)
    const snapshotDays = Math.min(30, profile.days);
    const snapshotRows = [];

    for (let d = snapshotDays; d >= 0; d--) {
      const snapDate = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      const dateStr = snapDate.toISOString().slice(0, 10);

      // Nur Samples berücksichtigen, die bis zu diesem Datum gemessen wurden
      const samplesUpToDate = userSamplesList.filter((s) => new Date(s.measuredAt) <= snapDate);
      if (samplesUpToDate.length === 0) continue;

      const scoreResult = computeScore({
        profile: { birthDate: profile.birthDate, sex: profile.sex },
        samples: samplesUpToDate,
        now: snapDate,
      });

      snapshotRows.push({
        userId: user.id,
        computedFor: dateStr,
        score: scoreResult.score,
        coverage: scoreResult.coverage,
        bioAge: scoreResult.bioAge,
        breakdown: scoreResult as unknown as Record<string, unknown>,
        engineVersion: scoreResult.engineVersion,
      });
    }

    if (snapshotRows.length > 0) {
      await db.insert(scoreSnapshots).values(snapshotRows).onConflictDoNothing();
    }

    const currentScore = computeScore({
      profile: { birthDate: profile.birthDate, sex: profile.sex },
      samples: userSamplesList,
      now,
    });

    console.log(
      `   ✓ ${profile.displayName.padEnd(20)} (${profile.email}) | Score: ${currentScore.score} (Band ${currentScore.band.low}) | Bio-Age: ${currentScore.bioAge} | ${profile.orgName} | KVNR: ${kvnr}`
    );
  }

  console.log('\n=============================================================');
  console.log('🎉 Alle Testdaten wurden erfolgreich eingespielt!');
  console.log('Zugangsdaten:');
  console.log('  • Nutzer:         demo@longevity.app / demo-longevity-2026');
  console.log('  • Insurer-Admin:  insurer-demo@longevity.app / insurer-longevity-2026');
  console.log('  • Platform-Admin: admin@longevity.app / admin-longevity-2026');
  console.log('  • Weitere Kassen: <kasse>-admin@longevity.app / demo-longevity-2026');
  console.log('=============================================================');
  return true;
}

if (process.argv[1] && (process.argv[1].endsWith('fullDemo.ts') || process.argv[1].endsWith('fullDemo.js'))) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fehler beim Seeden:', err);
      process.exit(1);
    });
}
