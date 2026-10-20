'use server'
import { revalidatePath } from 'next/cache'
import { setHealthSettings, type HealthSettings } from '@/lib/health'

export async function saveHealthSettings(data: Partial<HealthSettings>): Promise<HealthSettings> {
  const saved = await setHealthSettings(data)
  revalidatePath('/settings')
  revalidatePath('/connections')
  return saved
}
