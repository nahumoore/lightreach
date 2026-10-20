/**
 * Nodemailer transport factory for user-configured SMTP connections.
 *
 * IMPORTANT: This module runs server-side only (Node.js).
 * Never import it from 'use client' files.
 *
 * Usage:
 *   import { buildTransport, verifyConnection, sendMail } from '@workspace/core/email/transport'
 */

import nodemailer from "nodemailer";
import type { Transporter, SendMailOptions } from "nodemailer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal connection record shape expected from the DB schema. */
export interface SMTPConfig {
  smtpHost: string;
  smtpPort: number;
  /** true = TLS on connect (port 465), false = STARTTLS (port 587) */
  smtpSecure: boolean;
  smtpUser: string;
  /** Decrypted plaintext password — decrypt before passing here */
  smtpPass: string;
}

export interface SendPayload {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text version. If omitted, one is derived from `html`. */
  text?: string;
  replyTo?: string;
  /** RFC822 Message-ID to use (with angle brackets, e.g. <uuid@host>). When provided
   *  nodemailer uses this value verbatim, guaranteeing the stored ID matches the sent header. */
  messageId?: string;
  /** RFC822 In-Reply-To header — set when replying to a received message */
  inReplyTo?: string;
  /** RFC822 References header — space-separated message-ids for threading */
  references?: string;
  /** Extra headers added verbatim, e.g. List-Unsubscribe */
  headers?: Record<string, string>;
}

// Fail fast rather than hang forever against a black-holed or slow-to-respond host.
const CONNECTION_TIMEOUT_MS = 20_000;
const GREETING_TIMEOUT_MS = 20_000;
const SOCKET_TIMEOUT_MS = 30_000;

/** Strip CR/LF and wrap in quotes so a malicious/malformed display name can't inject headers. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/"/g, "'").trim();
}

/** Very small HTML → text fallback so plain-text-only mail clients still get readable content. */
function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Build a Message-ID rooted at the sending domain instead of a non-routable placeholder. */
export function buildMessageId(fromEmail: string, uuid: string): string {
  const domain = fromEmail.split("@")[1]?.trim() || "localhost";
  return `<${uuid}@${domain}>`;
}

/**
 * Append a plain-language opt-out line instead of a tracked unsubscribe link —
 * cold outreach with a bare "unsubscribe" URL reads as bulk/marketing mail and
 * hurts deliverability more than it helps. The inbox poller watches replies
 * for this exact phrasing and marks the lead unsubscribed automatically.
 *
 * Appended as plain text (not styled HTML) so it flows through the same
 * newline-to-<br> conversion as the rest of the body and reads like a normal
 * line of the message rather than a mismatched footer.
 */
export function appendUnsubscribeFooter(text: string): string {
  return `${text}\n\nIf you'd rather not hear from us again, just reply with "STOP" and we'll take you off this list.`;
}

// ---------------------------------------------------------------------------
// Transport builder
// ---------------------------------------------------------------------------

/**
 * Create a nodemailer transport from a connection record.
 * The caller is responsible for decrypting `smtpPass` first.
 */
export function buildTransport(config: SMTPConfig): Transporter {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    // When not using implicit TLS (port 465), require the server to upgrade via
    // STARTTLS rather than silently falling back to a plaintext connection.
    requireTLS: !config.smtpSecure,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });
}

/**
 * Verify that the SMTP connection works (i.e. credentials are accepted).
 * Returns `{ ok: true }` on success or `{ ok: false, error: string }` on failure.
 */
export async function verifyConnection(
  config: SMTPConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const transport = buildTransport(config);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    transport.close();
  }
}

/**
 * Send a single email through an SMTP connection.
 * Throws on failure — the caller should catch and update the message status.
 */
export async function sendMail(
  config: SMTPConfig,
  payload: SendPayload,
): Promise<{ messageId: string }> {
  const transport = buildTransport(config);

  try {
    const mailOptions: SendMailOptions = {
      from: `"${sanitizeHeaderValue(payload.fromName)}" <${payload.fromEmail}>`,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text ?? htmlToText(payload.html),
      replyTo: payload.replyTo,
      messageId: payload.messageId,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      headers: payload.headers,
    };

    const info = await transport.sendMail(mailOptions);
    return { messageId: info.messageId as string };
  } finally {
    transport.close();
  }
}
