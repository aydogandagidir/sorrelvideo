import { Resend } from "resend";
import { logger } from "./logger";

let cached: Resend | null = null;
function client(): Resend | null {
  if (cached) return cached;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  cached = new Resend(key);
  return cached;
}

function from(): string {
  return process.env.EMAIL_FROM ?? "Sorrel <noreply@sorrel.local>";
}

function appUrl(): string {
  return process.env.APP_URL?.replace(/\/$/, "") ?? "http://localhost:8080";
}

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Base helper. If RESEND_API_KEY is not set (typical for local dev), logs the
 * email content instead of trying to send it — so the app keeps working
 * end-to-end without external dependencies.
 */
async function sendEmail({ to, subject, html, text }: SendArgs): Promise<void> {
  const r = client();
  if (!r) {
    logger.warn(
      { to, subject, text },
      "[email] RESEND_API_KEY not set — email logged instead of sent",
    );
    return;
  }
  const { error } = await r.emails.send({
    from: from(),
    to,
    subject,
    html,
    text,
  });
  if (error) {
    logger.error({ err: error, to, subject }, "Resend email send failed");
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function sendVerificationEmail(args: {
  to: string;
  firstName: string | null;
  token: string;
}): Promise<void> {
  const link = `${appUrl()}/verify-email?token=${encodeURIComponent(args.token)}`;
  const name = args.firstName?.trim() || "there";
  const subject = "Verify your Sorrel email";
  const text =
    `Hi ${name},\n\n` +
    `Click the link below to verify your email address:\n${link}\n\n` +
    `If you didn't sign up for Sorrel, you can ignore this message.\n`;
  const html =
    `<p>Hi ${escape(name)},</p>` +
    `<p>Click the link below to verify your email address:</p>` +
    `<p><a href="${escape(link)}">${escape(link)}</a></p>` +
    `<p>If you didn't sign up for Sorrel, you can ignore this message.</p>`;
  await sendEmail({ to: args.to, subject, html, text });
}

export async function sendPasswordResetEmail(args: {
  to: string;
  firstName: string | null;
  token: string;
}): Promise<void> {
  const link = `${appUrl()}/reset-password?token=${encodeURIComponent(args.token)}`;
  const name = args.firstName?.trim() || "there";
  const subject = "Reset your Sorrel password";
  const text =
    `Hi ${name},\n\n` +
    `We received a request to reset your password. Click the link below ` +
    `within 30 minutes to set a new one:\n${link}\n\n` +
    `If you didn't request this, you can safely ignore it.\n`;
  const html =
    `<p>Hi ${escape(name)},</p>` +
    `<p>We received a request to reset your password. Click the link ` +
    `below within 30 minutes to set a new one:</p>` +
    `<p><a href="${escape(link)}">${escape(link)}</a></p>` +
    `<p>If you didn't request this, you can safely ignore it.</p>`;
  await sendEmail({ to: args.to, subject, html, text });
}
