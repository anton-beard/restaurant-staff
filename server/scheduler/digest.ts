import { getDigestTime, getSetting, OWNER_TELEGRAM_ID, setSetting, WEEKLY_DIGEST_SENT_FOR } from '../db/settings.js'
import { localParts, ymdLocal } from '../lib/time.js'
import { digestText } from '../stats/digest.js'
import type { SchedulerDeps } from './tick.js'

/**
 * Раз в понедельник после настроенного времени отправляет владельцу сводку за неделю.
 * Маркер WEEKLY_DIGEST_SENT_FOR ставится сразу после попытки отправки, независимо от
 * её результата, — чтобы неудачная/зависшая отправка не повторялась каждую минуту
 * до конца понедельника и не задублировала сообщение. Возвращает true только если
 * отправка реально удалась (toOwner вернул id).
 */
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
  setSetting(db, WEEKLY_DIGEST_SENT_FOR, today)
  return id !== null
}
