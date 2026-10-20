'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Switch } from '@workspace/ui/components/switch'
import { Separator } from '@workspace/ui/components/separator'
import { IconLoader } from '@tabler/icons-react'
import { saveHealthSettings } from './actions'
import type { HealthSettings } from '@/lib/health'

export function HealthSettingsForm({ initial }: { initial: HealthSettings }) {
  const [form, setForm] = useState<HealthSettings>(initial)
  const [isPending, startTransition] = useTransition()

  function set<K extends keyof HealthSettings>(key: K, value: HealthSettings[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleSave() {
    startTransition(async () => {
      try {
        await saveHealthSettings(form)
        toast.success('Mailbox health settings saved')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Something went wrong')
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="health-threshold">Bounce threshold (%)</Label>
          <Input
            id="health-threshold"
            type="number"
            min={0.1}
            max={100}
            step={0.1}
            value={form.bounceThreshold}
            onChange={(e) => set('bounceThreshold', Number(e.target.value))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="health-window">Window (days)</Label>
          <Input
            id="health-window"
            type="number"
            min={1}
            max={90}
            value={form.windowDays}
            onChange={(e) => set('windowDays', Number(e.target.value))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="health-min-sends">Minimum sends</Label>
          <Input
            id="health-min-sends"
            type="number"
            min={1}
            value={form.minSends}
            onChange={(e) => set('minSends', Number(e.target.value))}
          />
        </div>
      </div>

      <Separator />

      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="health-auto-pause" className="text-sm">
            Auto-pause on bounce spikes
          </Label>
          <p className="text-muted-foreground text-xs">
            Pause a mailbox when its bounce rate reaches the threshold. Resume it from
            Connections once the cause is fixed.
          </p>
        </div>
        <Switch
          id="health-auto-pause"
          checked={form.autoPause}
          onCheckedChange={(v) => set('autoPause', v)}
        />
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <IconLoader className="mr-1.5 size-4 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  )
}
