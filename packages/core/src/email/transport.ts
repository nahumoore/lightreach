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
  /** Optional plain-text version */
  text?: string;
  replyTo?: string;
  /** RFC822 Message-ID to use (with angle brackets, e.g. <uuid@host>). When provided
   *  nodemailer uses this value verbatim, guaranteeing the stored ID matches the sent header. */
  messageId?: string;
  /** RFC822 In-Reply-To header — set when replying to a received message */
  inReplyTo?: string;
  /** RFC822 References header — space-separated message-ids for threading */
  references?: string;
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
      from: `"${payload.fromName}" <${payload.fromEmail}>`,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      replyTo: payload.replyTo,
      messageId: payload.messageId,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
    };

    const info = await transport.sendMail(mailOptions);
    return { messageId: info.messageId as string };
  } finally {
    transport.close();
  }
}
