import { getEmployee } from '../db/employees.js'
import { getInstanceRow, listReminderCandidates, markReminderSent } from '../db/taskInstances.js'
import { taskDueText } from '../tasks/issue.js'
import { openTaskKeyboard } from '../bot/keyboards.js'
import type { SchedulerDeps } from './tick.js'

const TWO_HOURS = 2 * 60 * 60_000
const FOUR_HOURS = 4 * 60 * 60_000

export function reminderLeadMs(durationMs: number): number {
  return durationMs > FOUR_HOURS ? TWO_HOURS : Math.floor(durationMs / 2)
}

export async function sendReminders(deps: SchedulerDeps, now: Date): Promise<number> {
  let sent = 0
  for (const inst of listReminderCandidates(deps.db, now.toISOString())) {
    try {
      const due = new Date(inst.due_at)
      const duration = due.getTime() - new Date(inst.issued_at).getTime()
      if (due.getTime() - now.getTime() > reminderLeadMs(duration)) continue
      markReminderSent(deps.db, inst.id, now.toISOString())
      const row = getInstanceRow(deps.db, inst.id)
      const employee = inst.employee_id ? getEmployee(deps.db, inst.employee_id) : null
      if (!row || !employee?.telegram_id) continue
      const id = await deps.notifier.toEmployee(employee.telegram_id, `Напоминание: «${row.title}»\n${taskDueText(due, deps.tz, now)}`, {
        keyboard: openTaskKeyboard(inst.id),
      })
      if (id !== null) sent++
    } catch (err) {
      console.error('scheduler: sendReminders failed for task', inst.id, err)
    }
  }
  return sent
}
