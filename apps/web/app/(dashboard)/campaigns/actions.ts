'use server'

import {
  db,
  campaigns,
  campaignConnections,
  connections,
  lists,
  messages,
  sequences,
} from '@workspace/db'
import { eq, and, lte, isNotNull, asc, inArray } from 'drizzle-orm'
import { nextSendWindowStart } from '@workspace/core/rotation'
import { enqueueNewLeads } from '@/lib/enqueue-leads'
import { revalidatePath } from 'next/cache'

export type CreateCampaignInput = {
  name: string
  sequenceId: number | null
  listId: number | null
  connectionIds: number[]
  sendWindowStart: string
  sendWindowEnd: string
  timezone: string
  daysOfWeek: number[]
  dailyCap: number
  minDelaySeconds: number
  maxDelaySeconds: number
}

export async function createCampaign(data: CreateCampaignInput): Promise<number> {
  const [row] = await db
    .insert(campaigns)
    .values({
      name: data.name.trim(),
      sequenceId: data.sequenceId,
      listId: data.listId,
      sendWindowStart: data.sendWindowStart,
      sendWindowEnd: data.sendWindowEnd,
      timezone: data.timezone,
      daysOfWeek: data.daysOfWeek,
      dailyCap: data.dailyCap,
      minDelaySeconds: data.minDelaySeconds,
      maxDelaySeconds: data.maxDelaySeconds,
    })
    .returning({ id: campaigns.id })

  const campaignId = row!.id

  if (data.connectionIds.length > 0) {
    await db.insert(campaignConnections).values(
      data.connectionIds.map((cid) => ({ campaignId, connectionId: cid })),
    )
  }

  revalidatePath('/campaigns')
  return campaignId
}

/**
 * Partial update of a draft or paused campaign: only the fields present in
 * `data` change. The scheduler reads schedule, cap and mailbox settings from the
 * campaign on every tick, so those take effect immediately; on resume any
 * past-due messages are re-staggered with the new jitter and send window. The
 * sequence and list can only change while the campaign is still a draft, since
 * a launched campaign already has messages queued or sent for them.
 */
export async function updateCampaign(id: number, data: Partial<CreateCampaignInput>) {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id))
  if (!campaign) throw new Error('Campaign not found')

  if (campaign.status === 'running') {
    throw new Error('Pause the campaign before editing it')
  }
  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    throw new Error(`A ${campaign.status} campaign cannot be edited`)
  }

  const sequenceChanged =
    data.sequenceId !== undefined && data.sequenceId !== campaign.sequenceId
  const listChanged = data.listId !== undefined && data.listId !== campaign.listId
  if ((sequenceChanged || listChanged) && campaign.status !== 'draft') {
    throw new Error(
      'The sequence and list cannot be changed once a campaign has been launched. Create a new campaign instead',
    )
  }

  const minDelaySeconds = data.minDelaySeconds ?? campaign.minDelaySeconds
  const maxDelaySeconds = data.maxDelaySeconds ?? campaign.maxDelaySeconds
  if (minDelaySeconds > maxDelaySeconds) {
    throw new Error('minDelaySeconds cannot be greater than maxDelaySeconds')
  }

  if (data.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: data.timezone })
    } catch {
      throw new Error(`Unknown timezone: ${data.timezone}`)
    }
  }

  // Validate every referenced row before writing, so a bad id can't leave the
  // campaign half-updated.
  if (data.sequenceId != null) {
    const [seq] = await db
      .select({ id: sequences.id })
      .from(sequences)
      .where(eq(sequences.id, data.sequenceId))
    if (!seq) throw new Error('Sequence not found')
  }
  if (data.listId != null) {
    const [list] = await db.select({ id: lists.id }).from(lists).where(eq(lists.id, data.listId))
    if (!list) throw new Error('List not found')
  }
  const connectionIds = data.connectionIds ? [...new Set(data.connectionIds)] : undefined
  if (connectionIds && connectionIds.length > 0) {
    const found = await db
      .select({ id: connections.id })
      .from(connections)
      .where(inArray(connections.id, connectionIds))
    const foundIds = new Set(found.map((c) => c.id))
    const missing = connectionIds.filter((cid) => !foundIds.has(cid))
    if (missing.length > 0) throw new Error(`Connection not found: ${missing.join(', ')}`)
  }

  const patch: Partial<typeof campaigns.$inferInsert> = {}
  if (data.name !== undefined) patch.name = data.name.trim()
  if (data.sequenceId !== undefined) patch.sequenceId = data.sequenceId
  if (data.listId !== undefined) patch.listId = data.listId
  if (data.sendWindowStart !== undefined) patch.sendWindowStart = data.sendWindowStart
  if (data.sendWindowEnd !== undefined) patch.sendWindowEnd = data.sendWindowEnd
  if (data.timezone !== undefined) patch.timezone = data.timezone
  if (data.daysOfWeek !== undefined) patch.daysOfWeek = data.daysOfWeek
  if (data.dailyCap !== undefined) patch.dailyCap = data.dailyCap
  if (data.minDelaySeconds !== undefined) patch.minDelaySeconds = data.minDelaySeconds
  if (data.maxDelaySeconds !== undefined) patch.maxDelaySeconds = data.maxDelaySeconds

  // better-sqlite3 transactions are synchronous, hence .run() and no await.
  db.transaction((tx) => {
    if (Object.keys(patch).length > 0) {
      tx.update(campaigns).set(patch).where(eq(campaigns.id, id)).run()
    }
    if (connectionIds) {
      tx.delete(campaignConnections).where(eq(campaignConnections.campaignId, id)).run()
      if (connectionIds.length > 0) {
        tx.insert(campaignConnections)
          .values(connectionIds.map((cid) => ({ campaignId: id, connectionId: cid })))
          .run()
      }
    }
  })

  revalidatePath('/campaigns')
}

export async function launchCampaign(id: number) {
  const [campaign] = await db
    .select({
      id: campaigns.id,
      listId: campaigns.listId,
      minDelaySeconds: campaigns.minDelaySeconds,
      maxDelaySeconds: campaigns.maxDelaySeconds,
      sendWindowStart: campaigns.sendWindowStart,
      sendWindowEnd: campaigns.sendWindowEnd,
      timezone: campaigns.timezone,
      daysOfWeek: campaigns.daysOfWeek,
    })
    .from(campaigns)
    .where(eq(campaigns.id, id))

  if (!campaign) throw new Error('Campaign not found')

  await enqueueNewLeads(campaign)

  await db.update(campaigns).set({ status: 'running' }).where(eq(campaigns.id, id))
  revalidatePath('/campaigns')
}

export async function pauseCampaign(id: number) {
  await db.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, id))
  revalidatePath('/campaigns')
}

export async function resumeCampaign(id: number) {
  const [campaign] = await db
    .select({
      minDelaySeconds: campaigns.minDelaySeconds,
      maxDelaySeconds: campaigns.maxDelaySeconds,
      sendWindowStart: campaigns.sendWindowStart,
      sendWindowEnd: campaigns.sendWindowEnd,
      timezone: campaigns.timezone,
      daysOfWeek: campaigns.daysOfWeek,
    })
    .from(campaigns)
    .where(eq(campaigns.id, id))

  if (!campaign) throw new Error('Campaign not found')

  // While paused, queued messages keep their original scheduledAt. Any that came
  // due during the pause are now past-due and would all fire in the next tick as
  // a burst. Re-stagger just those from now using the campaign's jitter window,
  // preserving their original order. Messages still scheduled in the future
  // (e.g. later sequence steps with delayDays) are left untouched so we don't
  // pull intentional delays earlier.
  const now = Date.now()
  const pastDue = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.campaignId, id),
        eq(messages.status, 'queued'),
        isNotNull(messages.scheduledAt),
        lte(messages.scheduledAt, new Date(now)),
      ),
    )
    .orderBy(asc(messages.scheduledAt))

  if (pastDue.length > 0) {
    const avgDelayMs = ((campaign.minDelaySeconds + campaign.maxDelaySeconds) / 2) * 1000
    // Re-anchor to the next open send-window slot so resuming outside working
    // hours doesn't stamp past-due messages with a time the scheduler skips.
    const base = nextSendWindowStart(
      new Date(now),
      campaign.timezone,
      campaign.sendWindowStart,
      campaign.sendWindowEnd,
      campaign.daysOfWeek,
    ).getTime()
    for (let i = 0; i < pastDue.length; i++) {
      await db
        .update(messages)
        .set({ scheduledAt: new Date(base + i * avgDelayMs) })
        .where(eq(messages.id, pastDue[i]!.id))
    }
  }

  await db.update(campaigns).set({ status: 'running' }).where(eq(campaigns.id, id))
  revalidatePath('/campaigns')
}

export async function deleteCampaign(id: number) {
  await db.delete(campaigns).where(eq(campaigns.id, id))
  revalidatePath('/campaigns')
}
