/**
 * Bounce classification: decides what a delivery failure says about the recipient.
 *
 *   hard  the address is dead. Stop the lead and suppress the address everywhere.
 *   block a permanent rejection that is not proof the address is dead (a policy,
 *         spam or reputation block, or an error we can't read). Stop the lead,
 *         but do not suppress: the same address may be fine from another mailbox.
 *   soft  temporary (delayed delivery, full mailbox). Leave the lead active.
 *
 * Pure functions, no I/O. Fed by the DSN fields parsed in `imap.ts` and by the
 * error nodemailer throws when an SMTP server rejects a recipient.
 *
 * Usage:
 *   import { classifyBounce } from '@workspace/core/email/bounce'
 */

export type BounceKind = "hard" | "block" | "soft";

export interface BounceSignals {
  /** DSN `Action` field: failed, delayed, delivered, relayed, expanded */
  action?: string | null;
  /** Enhanced status code (RFC 3463), e.g. "5.1.1" */
  status?: string | null;
  /** DSN `Diagnostic-Code` or the SMTP error text */
  diagnostic?: string | null;
  /** Plain 3-digit SMTP reply code, for servers that send no enhanced status */
  smtpCode?: number | null;
  /** Subject of the bounce email, if there is one */
  subject?: string | null;
}

/** Mailbox full / over quota. The address is valid, the mailbox just can't take mail right now. */
const MAILBOX_FULL_RE = /\b(mailbox.*full|over.*quota|quota.*exceeded|exceeded.*storage|storage.*allocation)\b/i;

/** Rejections about us (reputation, content, policy), not about the recipient. */
const POLICY_BLOCK_RE = /\b(spam|blocked|blocklist|blacklist|dnsbl|poor reputation)\b/i;

/** Text that clearly says the recipient address does not exist. */
const NO_SUCH_RECIPIENT_RE =
  /\b(user.*unknown|unknown.*user|no.*such.*(user|recipient|mailbox|address)|mailbox.*unavailable|address.*rejected|does not exist|invalid.*(mailbox|recipient|address))\b/i;

/** Subject of a delay notice, e.g. "Delivery Status Notification (Delay)". */
const DELAY_SUBJECT_RE = /\bdelay(ed)?\b/i;

/**
 * Classify a failed delivery.
 *
 *   hard:  5.1.x (bad address), 5.2.1 (mailbox disabled)
 *   soft:  Action "delayed", any 4.x.x or 4xx, 5.2.2 or 552 (mailbox full)
 *   block: 5.7.x (policy or spam block) and any other permanent failure
 *
 * Only when the codes don't decide does the diagnostic text break the tie
 * ("mailbox full" is soft, "user unknown" is hard, "spam" is a block). A
 * failure with nothing to go on is a block, unless the subject says it was delayed.
 */
export function classifyBounce(signals: BounceSignals): BounceKind {
  const status = signals.status?.trim() ?? "";
  const text = signals.diagnostic ?? "";

  if (/^4\./.test(status)) return "soft";
  if (/^5\.2\.2$/.test(status)) return "soft";
  if (/^5\.7\./.test(status)) return "block";
  // 5.1.7 / 5.1.8 are about the sender's address (RFC 3463), not the recipient.
  if (/^5\.1\.[78]$/.test(status)) return "block";
  if (/^5\.1\./.test(status) || /^5\.2\.1$/.test(status)) return "hard";

  if (signals.action?.trim().toLowerCase() === "delayed") return "soft";

  // 552 is "exceeded storage allocation" (RFC 5321), same meaning as 5.2.2.
  if (signals.smtpCode === 552) return "soft";
  if (signals.smtpCode != null && signals.smtpCode >= 400 && signals.smtpCode < 500) return "soft";

  if (MAILBOX_FULL_RE.test(text)) return "soft";
  // Checked before the hard pattern so an ambiguous message never
  // permanently suppresses an address that may be perfectly valid.
  if (POLICY_BLOCK_RE.test(text)) return "block";
  if (NO_SUCH_RECIPIENT_RE.test(text)) return "hard";

  if (signals.subject && DELAY_SUBJECT_RE.test(signals.subject)) return "soft";
  return "block";
}
