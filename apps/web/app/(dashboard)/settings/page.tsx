import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Badge } from "@workspace/ui/components/badge"
import { Separator } from "@workspace/ui/components/separator"
import { Switch } from "@workspace/ui/components/switch"
import { Label } from "@workspace/ui/components/label"
import { Input } from "@workspace/ui/components/input"
import { Button } from "@workspace/ui/components/button"
import { getHealthSettings } from "@/lib/health"
import { HealthSettingsForm } from "./health-settings-form"
import {
  IconSettings,
  IconShield,
  IconHeartbeat,
  IconBell,
  IconPalette,
  IconCheck,
  IconX,
} from "@tabler/icons-react"

const encKeySet = !!process.env["APP_ENCRYPTION_KEY"]

export default async function SettingsPage() {
  const healthSettings = await getHealthSettings()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          App-level configuration and defaults.
        </p>
      </div>

      {/* Environment status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <IconShield className="size-4" />
            Environment status
          </CardTitle>
          <CardDescription>
            Required environment variables for Lightreach to function.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border px-4 py-3">
            <div>
              <p className="text-sm font-medium font-mono">APP_ENCRYPTION_KEY</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                AES-256 key for SMTP password encryption. 64 hex characters.
              </p>
            </div>
            {encKeySet ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 gap-1">
                <IconCheck className="size-3" />
                Set
              </Badge>
            ) : (
              <Badge className="bg-destructive/15 text-destructive gap-1">
                <IconX className="size-3" />
                Missing
              </Badge>
            )}
          </div>

          <div className="flex items-center justify-between rounded-md border px-4 py-3">
            <div>
              <p className="text-sm font-medium font-mono">DATABASE_URL</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                SQLite database path. Defaults to <code className="font-mono">file:./data.db</code>.
              </p>
            </div>
            <Badge className="bg-emerald-500/15 text-emerald-400 gap-1">
              <IconCheck className="size-3" />
              {process.env["DATABASE_URL"] ?? "file:./data.db (default)"}
            </Badge>
          </div>

          {!encKeySet && (
            <div className="bg-destructive/10 border-destructive/30 rounded-md border p-3 text-xs">
              <p className="text-destructive font-medium">Action required</p>
              <p className="text-muted-foreground mt-1">
                Generate a key and add it to <code className="font-mono">.env.local</code>:
              </p>
              <pre className="bg-muted mt-2 rounded p-2 font-mono text-xs">
                openssl rand -hex 32
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sending defaults */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <IconSettings className="size-4" />
            Sending defaults
          </CardTitle>
          <CardDescription>
            Default values used when creating new campaigns.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="send-start">Send window start</Label>
              <Input id="send-start" type="time" defaultValue="09:00" disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="send-end">Send window end</Label>
              <Input id="send-end" type="time" defaultValue="17:00" disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="min-delay">Min delay between sends (seconds)</Label>
              <Input id="min-delay" type="number" defaultValue={60} min={10} disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="max-delay">Max delay between sends (seconds)</Label>
              <Input id="max-delay" type="number" defaultValue={300} min={10} disabled />
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="weekend-send" className="text-sm">
                Allow weekend sends
              </Label>
              <p className="text-muted-foreground text-xs">
                Enable Saturday/Sunday in the default day-of-week schedule.
              </p>
            </div>
            <Switch id="weekend-send" disabled />
          </div>

          <div className="flex justify-end">
            <Button size="sm" disabled>
              Save defaults
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Mailbox health */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <IconHeartbeat className="size-4" />
            Mailbox health
          </CardTitle>
          <CardDescription>
            Bounce rate is measured per mailbox over the window. A mailbox with at least the
            minimum sends and a rate at or above the threshold is paused automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HealthSettingsForm initial={healthSettings} />
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <IconPalette className="size-4" />
            Appearance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Theme</Label>
              <p className="text-muted-foreground text-xs">
                Press <kbd className="bg-muted rounded px-1 font-mono text-xs">d</kbd>{" "}
                anywhere to toggle dark/light mode.
              </p>
            </div>
            <Badge variant="secondary">Dark (default)</Badge>
          </div>
        </CardContent>
      </Card>

      {/* About */}
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm">About Lightreach</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-1 text-xs">
          <p>
            Free, open-source, self-hosted cold-email outreach platform.
          </p>
          <p>
            No SaaS fees. Your credentials never leave your machine.
          </p>
          <p className="mt-2">
            <a
              href="https://github.com/nahumoore/lightreach"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              View on GitHub →
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
