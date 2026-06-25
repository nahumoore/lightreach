import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { IconMail, IconSend, IconUsers, IconArrowRight } from "@tabler/icons-react"
import Link from "next/link"
import { ActivityChart } from "./activity-chart"
import { db } from "@workspace/db"
import { connections, campaigns, leads, messages } from "@workspace/db/schema"
import { count, and, eq, gte, inArray } from "drizzle-orm"

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

async function getDashboardStats() {
  const connectionRow = await db.select({ total: count() }).from(connections)
  const connectionCount = connectionRow[0]?.total ?? 0

  const activeCampaignRow = await db
    .select({ total: count() })
    .from(campaigns)
    .where(inArray(campaigns.status, ["running", "scheduled"]))
  const activeCampaignCount = activeCampaignRow[0]?.total ?? 0

  const leadRow = await db.select({ total: count() }).from(leads)
  const leadCount = leadRow[0]?.total ?? 0

  // Last 7 calendar days (today + 6 days back)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    d.setHours(0, 0, 0, 0)
    return d
  })

  const weekStart = days[0]!
  const sentMessages = await db
    .select({ sentAt: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.status, "sent"), gte(messages.sentAt, weekStart)))

  const chartData = days.map((d) => ({
    day: DAY_LABELS[d.getDay()]!,
    emails: sentMessages.filter((m) => {
      if (!m.sentAt) return false
      const msg = new Date(m.sentAt)
      msg.setHours(0, 0, 0, 0)
      return msg.getTime() === d.getTime()
    }).length,
  }))

  return { connectionCount, activeCampaignCount, leadCount, chartData }
}

export default async function DashboardPage() {
  const { connectionCount, activeCampaignCount, leadCount, chartData } =
    await getDashboardStats()

  const stats = [
    {
      label: "Connected Mailboxes",
      value: connectionCount,
      description: "SMTP accounts ready to send",
      icon: IconMail,
      href: "/connections",
      color: "text-blue-400",
    },
    {
      label: "Active Campaigns",
      value: activeCampaignCount,
      description: "Campaigns currently running",
      icon: IconSend,
      href: "/campaigns",
      color: "text-amber-400",
    },
    {
      label: "Total Leads",
      value: leadCount,
      description: "Contacts across all lists",
      icon: IconUsers,
      href: "/leads",
      color: "text-violet-400",
    },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Your cold-email command center.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {stats.map((stat) => (
          <Link key={stat.href} href={stat.href} className="group">
            <Card className="hover:border-primary/40 transition-colors">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardDescription>{stat.label}</CardDescription>
                <stat.icon className={`size-4 ${stat.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{stat.value}</div>
                <p className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                  {stat.description}
                  <IconArrowRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Emails sent</CardTitle>
            <CardDescription>Activity over the last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityChart data={chartData} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
