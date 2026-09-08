import type { Db } from '../db/connect.js'
import { eligibleEmployees, type TaskTemplate } from '../db/taskTemplates.js'
import { addOffer, createInstance, type TaskInstance } from '../db/taskInstances.js'
import { formatLocal } from '../lib/time.js'
import type { Notifier } from '../notify.js'
import { claimKeyboard, openTaskKeyboard } from '../bot/keyboards.js'

export type IssueDeps = { db: Db; notifier: Notifier; tz: string }
export type IssueResult = { created: TaskInstance[]; notified: number }

export function taskDueText(due: Date, tz: string, now: Date): string {
  return `Срок: до ${formatLocal(due, tz, now)}`
}

export async function issueTemplate(deps: IssueDeps, template: TaskTemplate, slotAt: Date, now: Date): Promise<IssueResult> {
  const { db, notifier, tz } = deps
  const employees = eligibleEmployees(db, template)
  if (employees.length === 0) return { created: [], notified: 0 }

  const due = new Date(slotAt.getTime() + template.deadline_minutes * 60_000)
  const base = { template_id: template.id, slot_at: slotAt.toISOString(), issued_at: now.toISOString(), due_at: due.toISOString() }
  const dueText = taskDueText(due, tz, now)
  const created: TaskInstance[] = []
  let notified = 0

  if (template.distribution === 'each') {
    for (const e of employees) {
      const inst = createInstance(db, { ...base, employee_id: e.id, status: 'pending' })
      if (!inst) continue
      created.push(inst)
      if (e.telegram_id === null) continue
      const id = await notifier.toEmployee(e.telegram_id, `Новое задание: ${template.title}\n${dueText}`, {
        keyboard: openTaskKeyboard(inst.id),
      })
      if (id !== null) notified++
    }
    return { created, notified }
  }

  const inst = createInstance(db, { ...base, employee_id: null, status: 'open' })
  if (!inst) return { created: [], notified: 0 }
  created.push(inst)
  for (const e of employees) {
    if (e.telegram_id === null) continue
    const id = await notifier.toEmployee(e.telegram_id, `Задание для команды: ${template.title}\n${dueText}\nКто возьмёт?`, {
      keyboard: claimKeyboard(inst.id),
    })
    if (id !== null) {
      addOffer(db, inst.id, e.telegram_id, id)
      notified++
    }
  }
  return { created, notified }
}
