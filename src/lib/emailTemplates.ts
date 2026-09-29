const BRAND_GREEN = '#0f6e56';
const BRAND_GREEN_LIGHT = '#1d9e75';
const TEXT_DARK = '#22221f';
const TEXT_MUTED = '#55544f';
const BG = '#f4f5f2';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
        <tr>
          <td style="background:linear-gradient(135deg, ${BRAND_GREEN_LIGHT} 0%, ${BRAND_GREEN} 100%);padding:28px 32px;">
            <span style="color:#ffffff;font-size:18px;font-weight:600;letter-spacing:0.02em;">LONGEVITY</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;color:${TEXT_DARK};font-size:14px;line-height:1.6;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;border-top:1px solid rgba(0,0,0,0.06);color:${TEXT_MUTED};font-size:12px;">
            LONGEVITY · Wissenschaftlich fundiertes Vitalitäts-Tracking
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:999px;background:linear-gradient(135deg, ${BRAND_GREEN_LIGHT} 0%, ${BRAND_GREEN} 100%);">
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;border-radius:999px;">${escapeHtml(label)}</a>
  </td></tr></table>`;
}

function fallbackLink(url: string): string {
  const safeUrl = escapeHtml(url);
  return `<p style="color:${TEXT_MUTED};font-size:12px;word-break:break-all;">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br><a href="${safeUrl}" style="color:${BRAND_GREEN};">${safeUrl}</a></p>`;
}

export function verifyEmailTemplate(verifyUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: 'Bitte bestätige deine E-Mail-Adresse',
    text: `Willkommen bei LONGEVITY!\n\nBitte bestätige deine E-Mail-Adresse, um dein Konto vollständig zu nutzen.\n\nLink bestätigen: ${verifyUrl}\n\nDer Link ist eine Stunde gültig.\n\n---\nLONGEVITY · Wissenschaftlich fundiertes Vitalitäts-Tracking`,
    html: layout('E-Mail bestätigen', `
      <p style="margin:0 0 16px;">Willkommen bei LONGEVITY!</p>
      <p style="margin:0 0 24px;color:${TEXT_MUTED};">Bitte bestätige deine E-Mail-Adresse, um dein Konto vollständig zu nutzen.</p>
      <div style="margin:0 0 24px;">${button(verifyUrl, 'E-Mail bestätigen')}</div>
      <p style="margin:0 0 16px;color:${TEXT_MUTED};">Der Link ist eine Stunde gültig.</p>
      ${fallbackLink(verifyUrl)}
    `),
  };
}

export function passwordResetTemplate(resetUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: 'Passwort zurücksetzen',
    text: `Du hast ein neues Passwort angefordert.\n\nNeues Passwort setzen: ${resetUrl}\n\nDer Link ist eine Stunde gültig. Falls du das nicht warst, kannst du diese E-Mail ignorieren.\n\n---\nLONGEVITY · Wissenschaftlich fundiertes Vitalitäts-Tracking`,
    html: layout('Passwort zurücksetzen', `
      <p style="margin:0 0 16px;">Du hast ein neues Passwort angefordert.</p>
      <p style="margin:0 0 24px;color:${TEXT_MUTED};">Klicke auf den folgenden Button, um ein neues Passwort zu setzen.</p>
      <div style="margin:0 0 24px;">${button(resetUrl, 'Neues Passwort setzen')}</div>
      <p style="margin:0 0 16px;color:${TEXT_MUTED};">Der Link ist eine Stunde gültig. Falls du das nicht warst, kannst du diese E-Mail ignorieren.</p>
      ${fallbackLink(resetUrl)}
    `),
  };
}

export function insurerRequestReceivedTemplate(company: string): { subject: string; html: string; text: string } {
  const isGeneric = !company || ['Community / Feedback', 'Forschung & DHBW', 'Privatperson / Allgemein', 'Nutzer Feedback', 'Allgemeine Anfrage'].includes(company);
  const mentionText = isGeneric ? '' : ` für ${company}`;
  const mentionHtml = isGeneric ? '' : ` für <strong style="color:${TEXT_DARK};">${escapeHtml(company)}</strong>`;

  return {
    subject: isGeneric ? 'Ihre Nachricht an LONGEVITY ist eingegangen' : 'Ihre Anfrage bei LONGEVITY ist eingegangen',
    text: `Hallo,\n\nvielen Dank für Ihre Kontaktaufnahme mit LONGEVITY${mentionText}. Wir haben Ihre Nachricht erhalten und melden uns in Kürze persönlich bei Ihnen.\n\n---\nLONGEVITY · Wissenschaftlich fundiertes Vitalitäts-Tracking`,
    html: layout(isGeneric ? 'Nachricht erhalten' : 'Anfrage erhalten', `
      <p style="margin:0 0 16px;">Hallo,</p>
      <p style="margin:0 0 24px;color:${TEXT_MUTED};">vielen Dank für Ihre Kontaktaufnahme mit LONGEVITY${mentionHtml}. Wir haben Ihre Nachricht erhalten und melden uns in Kürze persönlich bei Ihnen.</p>
    `),
  };
}

export function insurerInviteTemplate(orgName: string, inviteUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: 'Einladung: LONGEVITY-Zugang für Krankenkassen',
    text: `Hallo,\n\nSie wurden als Krankenkassen-Administrator für ${orgName} bei LONGEVITY eingeladen.\n\nBitte legen Sie über den folgenden Link Ihr Passwort fest, um den Zugang zu aktivieren:\n${inviteUrl}\n\nDer Link ist 7 Tage gültig.\n\n---\nLONGEVITY · Wissenschaftlich fundiertes Vitalitäts-Tracking`,
    html: layout('Krankenkassen-Einladung', `
      <p style="margin:0 0 16px;">Hallo,</p>
      <p style="margin:0 0 24px;color:${TEXT_MUTED};">Sie wurden als Krankenkassen-Administrator für <strong style="color:${TEXT_DARK};">${escapeHtml(orgName)}</strong> bei LONGEVITY eingeladen.</p>
      <p style="margin:0 0 24px;color:${TEXT_MUTED};">Bitte legen Sie über den folgenden Button Ihr Passwort fest, um den Zugang zu aktivieren.</p>
      <div style="margin:0 0 24px;">${button(inviteUrl, 'Zugang aktivieren')}</div>
      <p style="margin:0 0 16px;color:${TEXT_MUTED};">Der Link ist 7 Tage gültig.</p>
      ${fallbackLink(inviteUrl)}
    `),
  };
}

export function deleteAccountTemplate(confirmUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: 'Bestätige die Löschung deines LONGEVITY-Kontos',
    text: `Du hast die Löschung deines LONGEVITY-Kontos angefordert.\n\nBitte bestätige die endgültige Löschung über den folgenden Link:\n${confirmUrl}\n\nDer Link ist 30 Minuten gültig. Dein Konto und alle gespeicherten Gesundheitsdaten werden unwiderruflich gelöscht. Falls du das nicht warst, kannst du diese E-Mail ignorieren — es passiert nichts, solange du nicht auf den Link klickst.\n\n---\nLONGEVITY · Wissenschaftlich fundiertes Vitalitäts-Tracking`,
    html: layout('Konto löschen bestätigen', `
      <p style="margin:0 0 16px;">Du hast die Löschung deines LONGEVITY-Kontos angefordert.</p>
      <p style="margin:0 0 24px;color:${TEXT_MUTED};">Bitte bestätige die endgültige Löschung über den folgenden Button.</p>
      <div style="margin:0 0 24px;">${button(confirmUrl, 'Konto endgültig löschen')}</div>
      <p style="margin:0 0 16px;color:${TEXT_MUTED};">Der Link ist 30 Minuten gültig. Dein Konto und alle gespeicherten Gesundheitsdaten werden unwiderruflich gelöscht. Falls du das nicht warst, kannst du diese E-Mail ignorieren — es passiert nichts, solange du nicht auf den Link klickst.</p>
      ${fallbackLink(confirmUrl)}
    `),
  };
}

export interface WeeklyReportEmailData {
  displayName?: string | null;
  score: number;
  delta: number;
  bestMetricLabel: string;
  worstMetricLabel: string;
  streakDays: number;
  dashboardUrl: string;
}

export function weeklyReportTemplate(data: WeeklyReportEmailData): { subject: string; html: string; text: string } {
  const name = data.displayName ? escapeHtml(data.displayName) : null;
  const greeting = name ? `Hallo ${name},` : 'Hallo,';
  const deltaSign = data.delta > 0 ? `+${data.delta.toFixed(1)}` : `${data.delta.toFixed(1)}`;
  const deltaColor = data.delta >= 0 ? BRAND_GREEN : '#c2410c';

  return {
    subject: `Dein wöchentlicher LONGEVITY Vitalitätsbericht (Score: ${Math.round(data.score)})`,
    text: `${greeting}\n\nhier ist deine persönliche Zusammenfassung der letzten 7 Tage auf LONGEVITY.\n\nAktueller Score: ${Math.round(data.score)} (${deltaSign} Pkt.)\nTracking-Streak: ${data.streakDays} Tage\n\nStärkste Kennzahl: ${data.bestMetricLabel}\nGrößter Hebel: ${data.worstMetricLabel}\n\nZum vollständigen Bericht: ${data.dashboardUrl}\n\n---\nLONGEVITY · Wissenschaftlich fundiertes Vitalitäts-Tracking`,
    html: layout('Wöchentlicher Vitalitätsbericht', `
      <p style="margin:0 0 16px;">${greeting}</p>
      <p style="margin:0 0 24px;color:${TEXT_MUTED};">hier ist deine persönliche Zusammenfassung der letzten 7 Tage auf LONGEVITY.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};border-radius:12px;margin:0 0 24px;padding:16px;">
        <tr>
          <td style="padding:8px 12px;">
            <div style="font-size:11px;color:${TEXT_MUTED};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Aktueller Score</div>
            <div style="font-size:28px;font-weight:700;color:${TEXT_DARK};">${Math.round(data.score)}</div>
            <div style="font-size:12px;color:${deltaColor};font-weight:600;margin-top:2px;">${deltaSign} Pkt. im Vergleich zur Vorwoche</div>
          </td>
          <td style="padding:8px 12px;text-align:right;">
            <div style="font-size:11px;color:${TEXT_MUTED};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Tracking-Streak</div>
            <div style="font-size:24px;font-weight:700;color:${TEXT_DARK};">${data.streakDays} Tage</div>
          </td>
        </tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:13px;color:${TEXT_MUTED};">Stärkste Kennzahl:</td>
          <td style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:13px;font-weight:600;color:${TEXT_DARK};text-align:right;">${escapeHtml(data.bestMetricLabel)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:13px;color:${TEXT_MUTED};">Größter Hebel:</td>
          <td style="padding:8px 0;font-size:13px;font-weight:600;color:${TEXT_DARK};text-align:right;">${escapeHtml(data.worstMetricLabel)}</td>
        </tr>
      </table>

      <div style="margin:0 0 24px;">${button(data.dashboardUrl, 'Zum vollständigen Bericht')}</div>
      ${fallbackLink(data.dashboardUrl)}
    `),
  };
}
