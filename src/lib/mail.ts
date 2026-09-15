import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
    return transporter;
  }

  if (env.SMTP_URL) {
    transporter = nodemailer.createTransport(env.SMTP_URL);
    return transporter;
  }

  return null;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

export async function sendMail(message: MailMessage): Promise<void> {
  const t = getTransporter();
  if (!t) {
    throw new Error('Kein SMTP-Transport konfiguriert (SMTP_URL oder SMTP_HOST/SMTP_USER/SMTP_PASS setzen).');
  }
  await t.sendMail({
    from: env.MAIL_FROM ?? 'LONGEVITY <no-reply@longevity.app>',
    to: message.to,
    subject: message.subject,
    html: message.html,
  });
}
