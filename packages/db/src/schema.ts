import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// connections — SMTP mailboxes
// ---------------------------------------------------------------------------
export const connections = sqliteTable("connections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  fromName: text("from_name").notNull(),
  fromEmail: text("from_email").notNull(),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull().default(587),
  smtpSecure: integer("smtp_secure", { mode: "boolean" }).notNull().default(false),
  smtpUser: text("smtp_user").notNull(),
  /** AES-256-GCM encrypted — never return raw to the client */
  smtpPassEncrypted: text("smtp_pass_encrypted").notNull(),
  dailyLimit: integer("daily_limit").notNull().default(50),
  /** 'active' | 'paused' | 'error' */
  status: text("status").notNull().default("active"),
  lastTestedAt: integer("last_tested_at", { mode: "timestamp" }),
  lastError: text("last_error"),
  imapEnabled: integer("imap_enabled", { mode: "boolean" }).notNull().default(false),
  imapSameAsSmtp: integer("imap_same_as_smtp", { mode: "boolean" }).notNull().default(true),
  imapHost: text("imap_host"),
  imapPort: integer("imap_port").default(993),
  imapSecure: integer("imap_secure", { mode: "boolean" }).default(true),
  imapUser: text("imap_user"),
  imapPassEncrypted: text("imap_pass_encrypted"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// lists — named lead lists
// ---------------------------------------------------------------------------
export const lists = sqliteTable("lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// leads — individual contacts
// ---------------------------------------------------------------------------
export const leads = sqliteTable("leads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  listId: integer("list_id")
    .notNull()
    .references(() => lists.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  email: text("email").notNull(),
  company: text("company").notNull().default(""),
  openingLine: text("opening_line").notNull().default(""),
  /** JSON object for arbitrary extra fields */
  customFields: text("custom_fields", { mode: "json" })
    .$type<Record<string, string>>()
    .default({}),
  /** 'new' | 'contacted' | 'replied' | 'bounced' | 'unsubscribed' */
  status: text("status").notNull().default("new"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// sequences — multi-step email sequences (replaces single templates)
// ---------------------------------------------------------------------------
export const sequences = sqliteTable("sequences", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// sequence_steps — individual emails within a sequence (ordered)
// ---------------------------------------------------------------------------
export const sequenceSteps = sqliteTable("sequence_steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sequenceId: integer("sequence_id")
    .notNull()
    .references(() => sequences.id, { onDelete: "cascade" }),
  /** 1-based position within the sequence */
  position: integer("position").notNull(),
  /** Supports {a|b|c} spintax */
  subject: text("subject").notNull().default(""),
  /** Supports {a|b|c} spintax and {{variable|fallback}} */
  body: text("body").notNull().default(""),
  /** Days to wait after the previous step (0 = send immediately / same day for step 1) */
  delayDays: integer("delay_days").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// campaigns — pair sequence + list + schedule
// ---------------------------------------------------------------------------
export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sequenceId: integer("sequence_id").references(() => sequences.id, {
    onDelete: "set null",
  }),
  listId: integer("list_id").references(() => lists.id, {
    onDelete: "set null",
  }),
  /** 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' */
  status: text("status").notNull().default("draft"),

  // --- Schedule settings ---
  /** "HH:MM" 24-hour, e.g. "09:00" */
  sendWindowStart: text("send_window_start").notNull().default("09:00"),
  /** "HH:MM" 24-hour, e.g. "17:00" */
  sendWindowEnd: text("send_window_end").notNull().default("17:00"),
  /** IANA timezone, e.g. "America/New_York" */
  timezone: text("timezone").notNull().default("UTC"),
  /** JSON array of 0-6 (0=Sun). e.g. [1,2,3,4,5] = Mon-Fri */
  daysOfWeek: text("days_of_week", { mode: "json" })
    .$type<number[]>()
    .notNull()
    .default([1, 2, 3, 4, 5]),
  /** Max emails per day across all mailboxes */
  dailyCap: integer("daily_cap").notNull().default(100),
  /** Min seconds to wait between sends (jitter lower bound) */
  minDelaySeconds: integer("min_delay_seconds").notNull().default(60),
  /** Max seconds to wait between sends (jitter upper bound) */
  maxDelaySeconds: integer("max_delay_seconds").notNull().default(300),

  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// campaign_connections — which mailboxes a campaign rotates through
// ---------------------------------------------------------------------------
export const campaignConnections = sqliteTable(
  "campaign_connections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("campaign_connection_unique").on(
      table.campaignId,
      table.connectionId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// messages — per-lead send queue + delivery log
// ---------------------------------------------------------------------------
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: integer("campaign_id")
    .references(() => campaigns.id, { onDelete: "cascade" }),
  leadId: integer("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  connectionId: integer("connection_id").references(() => connections.id, {
    onDelete: "set null",
  }),
  /** Step position within the sequence that this message corresponds to */
  stepPosition: integer("step_position").notNull().default(1),
  /** 'queued' | 'scheduled' | 'sent' | 'failed' | 'skipped' */
  status: text("status").notNull().default("queued"),
  scheduledAt: integer("scheduled_at", { mode: "timestamp" }),
  sentAt: integer("sent_at", { mode: "timestamp" }),
  /** RFC822 Message-ID of the sent email — used to match inbound replies/bounces */
  messageId: text("message_id"),
  /** Spintax already resolved + variables substituted */
  renderedSubject: text("rendered_subject"),
  renderedBody: text("rendered_body"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// inbound_emails — received mail fetched via IMAP across all mailboxes
// ---------------------------------------------------------------------------
export const inboundEmails = sqliteTable(
  "inbound_emails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    connectionId: integer("connection_id").references(() => connections.id, {
      onDelete: "cascade",
    }),
    /** IMAP UID within the INBOX folder — used for deduplication per mailbox */
    uid: integer("uid"),
    /** RFC822 Message-ID header */
    messageId: text("message_id"),
    /** In-Reply-To header value */
    inReplyTo: text("in_reply_to"),
    /** References header — space-separated message-ids */
    references: text("references"),
    fromName: text("from_name").notNull().default(""),
    fromEmail: text("from_email").notNull().default(""),
    toEmail: text("to_email").notNull().default(""),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    /** true when subject/body matched a configured filter keyword */
    isFiltered: integer("is_filtered", { mode: "boolean" }).notNull().default(false),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    /** set when the user sends a reply to this inbound email */
    repliedAt: integer("replied_at", { mode: "timestamp" }),
    /** 'none' | 'interested' | 'not_interested' | 'meeting_booked' | 'out_of_office' | 'do_not_contact' */
    category: text("category").notNull().default("none"),
    receivedAt: integer("received_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("inbound_email_uid_unique").on(table.connectionId, table.uid),
  ],
);

// ---------------------------------------------------------------------------
// app_settings — simple key-value store for app-level configuration
// ---------------------------------------------------------------------------
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ---------------------------------------------------------------------------
// Inferred types — convenient for use across the app
// ---------------------------------------------------------------------------
export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;

export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

export type Sequence = typeof sequences.$inferSelect;
export type NewSequence = typeof sequences.$inferInsert;

export type SequenceStep = typeof sequenceSteps.$inferSelect;
export type NewSequenceStep = typeof sequenceSteps.$inferInsert;

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;

export type CampaignConnection = typeof campaignConnections.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type InboundEmail = typeof inboundEmails.$inferSelect;
export type NewInboundEmail = typeof inboundEmails.$inferInsert;

export type AppSetting = typeof appSettings.$inferSelect;
