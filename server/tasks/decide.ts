import type { Db } from '../db/connect.js'
import { getEmployee } from '../db/employees.js'
import { setInstanceStatus } from '../db/taskInstances.js'
import { getReviewRow, setOwnerDecision, type ReviewRow } from '../db/taskSubmissions.js'
import type { Notifier } from '../notify.js'
import { openTaskKeyboard } from '../bot/keyboards.js'

export function decideByScore(score: number, threshold: number): 'auto_accepted' | 'needs_review' {
  return score >= threshold ? 'auto_accepted' : 'needs_review'
}

export type DecisionDeps = { db: Db; notifier: Notifier; tz: string }
export type OwnerDecisionResult = { ok: true; instanceId: number } | { ok: false; reason: 'not_found' | 'already_decided' }

export async function applyOwnerDecision(
  deps: DecisionDeps, submissionId: number, decision: 'accept' | 'reject', comment: string | null, now: Date,
): Promise<OwnerDecisionResult> {
  const { db, notifier } = deps
  const row = getReviewRow(db, submissionId)
  if (!row) return { ok: false, reason: 'not_found' }
  const ok = setOwnerDecision(db, submissionId, decision === 'accept' ? 'owner_accepted' : 'owner_rejected', comment, now.toISOString())
  if (!ok) return { ok: false, reason: 'already_decided' }

  const employee = getEmployee(db, row.employee_id)
  if (decision === 'accept') {
    setInstanceStatus(db, row.instance_id, 'accepted', { completed_at: now.toISOString() })
    if (employee?.telegram_id) await notifier.toEmployee(employee.telegram_id, `Задание «${row.title}» принято владельцем.`)
  } else {
    setInstanceStatus(db, row.instance_id, 'pending')
    if (employee?.telegram_id) {
      await notifier.toEmployee(
        employee.telegram_id,
        `Задание «${row.title}» не принято: ${comment ?? 'без комментария'}.\nПереснимите и отправьте снова.`,
        { keyboard: openTaskKeyboard(row.instance_id) },
      )
    }
  }
  return { ok: true, instanceId: row.instance_id }
}

export function ownerReviewCaption(row: ReviewRow): string {
  const lines = [`Проверка: ${row.title}`, `Сотрудник: ${row.employee_name}`]
  if (row.ai_status === 'done' && row.ai_score !== null) {
    lines.push(`Оценка ИИ: ${row.ai_score} из 100`)
    if (row.ai_verdict) lines.push(row.ai_verdict)
    if (row.ai_issues.length) lines.push('Замечания: ' + row.ai_issues.join('; '))
  } else {
    lines.push('ИИ недоступен, проверьте вручную.')
  }
  const text = lines.join('\n')
  return text.length > 1000 ? text.slice(0, 997) + '…' : text
}
