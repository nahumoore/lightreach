import { db, connections } from '@workspace/db'
import { computeMailboxHealth } from '@/lib/health'
import { ConnectionsView } from './connections-view'

export default async function ConnectionsPage() {
  const [rows, mailboxHealth] = await Promise.all([
    db.select().from(connections).orderBy(connections.createdAt),
    computeMailboxHealth(),
  ])

  const safe = rows.map(({ smtpPassEncrypted: _sp, imapPassEncrypted: _ip, lastTestedAt, createdAt, ...rest }) => ({
    ...rest,
    lastTestedAt: lastTestedAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
  }))

  const health = Object.fromEntries(mailboxHealth.map((h) => [h.connectionId, h]))

  return <ConnectionsView connections={safe} health={health} />
}
