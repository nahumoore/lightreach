import { db, connections } from '@workspace/db'
import { getWarmupStatus } from '@/lib/warmup'
import { ConnectionsView } from './connections-view'

export default async function ConnectionsPage() {
  const [rows, warmup] = await Promise.all([
    db.select().from(connections).orderBy(connections.createdAt),
    getWarmupStatus(),
  ])

  const safe = rows.map(({ smtpPassEncrypted: _sp, imapPassEncrypted: _ip, lastTestedAt, createdAt, warmupStartedAt, ...rest }) => ({
    ...rest,
    lastTestedAt: lastTestedAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    warmupStartedAt: warmupStartedAt?.toISOString() ?? null,
    warmup: warmup.find((w) => w.connectionId === rest.id) ?? null,
  }))

  return <ConnectionsView connections={safe} />
}
