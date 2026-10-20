import { db, inboundEmails, connections, campaigns, appSettings } from '@workspace/db'
import { eq, desc } from 'drizzle-orm'
import { InboxView } from './inbox-view'

export type InboundRow = {
  id: number
  fromName: string
  fromEmail: string
  toEmail: string
  subject: string
  bodyText: string | null
  bodyHtml: string | null
  isFiltered: boolean
  isBounce: boolean
  isAutoReply: boolean
  isRead: boolean
  category: string
  receivedAt: string | null
  connectionId: number | null
  connectionLabel: string | null
  connectionFromEmail: string | null
  leadId: number | null
  campaignId: number | null
  campaignName: string | null
  messageId: string | null
  inReplyTo: string | null
  references: string | null
  repliedAt: string | null
}

export default async function InboxPage() {
  const [rawEmails, keywordRow] = await Promise.all([
    db
      .select({
        id: inboundEmails.id,
        fromName: inboundEmails.fromName,
        fromEmail: inboundEmails.fromEmail,
        toEmail: inboundEmails.toEmail,
        subject: inboundEmails.subject,
        bodyText: inboundEmails.bodyText,
        bodyHtml: inboundEmails.bodyHtml,
        isFiltered: inboundEmails.isFiltered,
        isBounce: inboundEmails.isBounce,
        isAutoReply: inboundEmails.isAutoReply,
        isRead: inboundEmails.isRead,
        category: inboundEmails.category,
        receivedAt: inboundEmails.receivedAt,
        connectionId: inboundEmails.connectionId,
        connectionLabel: connections.label,
        connectionFromEmail: connections.fromEmail,
        leadId: inboundEmails.leadId,
        campaignId: inboundEmails.campaignId,
        campaignName: campaigns.name,
        messageId: inboundEmails.messageId,
        inReplyTo: inboundEmails.inReplyTo,
        references: inboundEmails.references,
        repliedAt: inboundEmails.repliedAt,
      })
      .from(inboundEmails)
      .leftJoin(connections, eq(inboundEmails.connectionId, connections.id))
      .leftJoin(campaigns, eq(inboundEmails.campaignId, campaigns.id))
      .where(eq(inboundEmails.isDuplicate, false))
      .orderBy(desc(inboundEmails.receivedAt))
      .limit(500),

    db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, 'filter_keywords')),
  ])

  const rows: InboundRow[] = rawEmails.map((r) => ({
    ...r,
    receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
    repliedAt: r.repliedAt ? r.repliedAt.toISOString() : null,
  }))

  return (
    <InboxView
      emails={rows}
      filteredKeywords={keywordRow[0]?.value ?? ''}
    />
  )
}
