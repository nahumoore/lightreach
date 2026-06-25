import {
  db,
  messages,
  campaigns,
  leads,
  connections,
  sequenceSteps,
  campaignConnections,
} from '@workspace/db'
import { eq, or, desc, asc, and } from 'drizzle-orm'
import { EmailsView } from './emails-view'

export type EmailRow = {
  id: number
  status: string
  stepPosition: number
  scheduledAt: string | null
  sentAt: string | null
  /** renderedSubject for sent; templateSubject for queued/scheduled */
  subject: string | null
  error: string | null
  campaignName: string | null
  leadEmail: string
  leadFirstName: string
  leadLastName: string
  fromEmail: string | null
  fromName: string | null
}

const MESSAGE_FIELDS = {
  id: messages.id,
  campaignId: messages.campaignId,
  status: messages.status,
  stepPosition: messages.stepPosition,
  scheduledAt: messages.scheduledAt,
  sentAt: messages.sentAt,
  renderedSubject: messages.renderedSubject,
  connectionId: messages.connectionId,
  error: messages.error,
  campaignName: campaigns.name,
  leadEmail: leads.email,
  leadFirstName: leads.firstName,
  leadLastName: leads.lastName,
  fromEmail: connections.fromEmail,
  fromName: connections.fromName,
  templateSubject: sequenceSteps.subject,
}

function toRow(
  r: {
    id: number
    campaignId: number | null
    status: string
    stepPosition: number
    scheduledAt: Date | null
    sentAt: Date | null
    renderedSubject: string | null
    connectionId: number | null
    error: string | null
    campaignName: string | null
    leadEmail: string | null
    leadFirstName: string | null
    leadLastName: string | null
    fromEmail: string | null
    fromName: string | null
    templateSubject: string | null
  },
  campaignFromMap: Map<number, { fromEmail: string; fromName: string }>,
): EmailRow {
  // Use rendered subject if available, fall back to raw template subject
  const subject = r.renderedSubject ?? r.templateSubject ?? null

  // Use the message's assigned connection; fall back to any connection on the campaign
  let fromEmail = r.fromEmail
  let fromName = r.fromName
  if (!fromEmail) {
    const fallback = r.campaignId != null ? campaignFromMap.get(r.campaignId) : undefined
    if (fallback) {
      fromEmail = fallback.fromEmail
      fromName = fallback.fromName
    }
  }

  return {
    id: r.id,
    status: r.status,
    stepPosition: r.stepPosition,
    subject,
    error: r.error,
    campaignName: r.campaignName,
    leadEmail: r.leadEmail ?? '',
    leadFirstName: r.leadFirstName ?? '',
    leadLastName: r.leadLastName ?? '',
    fromEmail,
    fromName,
    scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : null,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
  }
}

export default async function EmailsPage() {
  const [scheduledRaw, sentRaw, campaignConnRows] = await Promise.all([
    db
      .select(MESSAGE_FIELDS)
      .from(messages)
      .leftJoin(campaigns, eq(messages.campaignId, campaigns.id))
      .leftJoin(leads, eq(messages.leadId, leads.id))
      .leftJoin(connections, eq(messages.connectionId, connections.id))
      .leftJoin(
        sequenceSteps,
        and(
          eq(sequenceSteps.sequenceId, campaigns.sequenceId!),
          eq(sequenceSteps.position, messages.stepPosition),
        ),
      )
      .where(or(eq(messages.status, 'queued'), eq(messages.status, 'scheduled')))
      .orderBy(asc(messages.scheduledAt))
      .limit(500),

    db
      .select(MESSAGE_FIELDS)
      .from(messages)
      .leftJoin(campaigns, eq(messages.campaignId, campaigns.id))
      .leftJoin(leads, eq(messages.leadId, leads.id))
      .leftJoin(connections, eq(messages.connectionId, connections.id))
      .leftJoin(
        sequenceSteps,
        and(
          eq(sequenceSteps.sequenceId, campaigns.sequenceId!),
          eq(sequenceSteps.position, messages.stepPosition),
        ),
      )
      .where(eq(messages.status, 'sent'))
      .orderBy(desc(messages.sentAt))
      .limit(500),

    // First connection per campaign — used as fallback From when message has no connectionId
    db
      .select({
        campaignId: campaignConnections.campaignId,
        fromEmail: connections.fromEmail,
        fromName: connections.fromName,
      })
      .from(campaignConnections)
      .leftJoin(connections, eq(campaignConnections.connectionId, connections.id)),
  ])

  // Build map: campaignId → first connection with a real fromEmail
  const campaignFromMap = new Map<number, { fromEmail: string; fromName: string }>()
  for (const row of campaignConnRows) {
    if (!campaignFromMap.has(row.campaignId) && row.fromEmail) {
      campaignFromMap.set(row.campaignId, {
        fromEmail: row.fromEmail,
        fromName: row.fromName ?? '',
      })
    }
  }

  return (
    <EmailsView
      scheduled={scheduledRaw.map((r) => toRow(r, campaignFromMap))}
      sent={sentRaw.map((r) => toRow(r, campaignFromMap))}
    />
  )
}
