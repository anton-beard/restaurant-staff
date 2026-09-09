import { getDigestTime, getSetting, OWNER_TELEGRAM_ID, setSetting, WEEKLY_DIGEST_SENT_FOR } from '../db/settings.js'
import { localParts, ymdLocal } from '../lib/time.js'
import { digestText } from '../stats/digest.js'
import type { SchedulerDeps } from './tick.js'

export async function weeklyDigest(deps: SchedulerDeps, now: Date): Promise<boolean> {
  const { db, tz } = deps
  if (!getSetting(db, OWNER_TELEGRAM_ID)) return false
  const p = localParts(now, tz)
  if (p.weekday !== 1) return false
  const hhmm = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
  if (hhmm < getDigestTime(db)) return false
  const today = ymdLocal(now, tz)
  if (getSetting(db, WEEKLY_DIGEST_SENT_FOR) === today) return false
  const id = await deps.notifier.toOwner(digestText(db, now, tz))
  if (id === null) return false
  setSetting(db, WEEKLY_DIGEST_SENT_FOR, today)
  return true
}
