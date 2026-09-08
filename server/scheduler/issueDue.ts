import { listDueTemplates, setNextRunAt } from '../db/taskTemplates.js'
import { issueTemplate } from '../tasks/issue.js'
import { nextRun } from '../tasks/schedule.js'
import type { SchedulerDeps } from './tick.js'

export const MISSED_SLOT_GRACE_MS = 60 * 60_000

export async function issueDueTemplates(deps: SchedulerDeps, now: Date): Promise<number> {
  let issued = 0
  for (const t of listDueTemplates(deps.db, now.toISOString())) {
    if (!t.schedule || !t.next_run_at) continue
    const slot = new Date(t.next_run_at)
    if (now.getTime() - slot.getTime() > MISSED_SLOT_GRACE_MS) {
      console.warn(`scheduler: skipping missed slot ${t.next_run_at} for template ${t.id}`)
    } else {
      const r = await issueTemplate({ db: deps.db, notifier: deps.notifier, tz: deps.tz }, t, slot, now)
      issued += r.created.length
    }
    const from = new Date(Math.max(slot.getTime(), now.getTime() - MISSED_SLOT_GRACE_MS))
    setNextRunAt(deps.db, t.id, nextRun(t.schedule, from, deps.tz).toISOString())
  }
  return issued
}
