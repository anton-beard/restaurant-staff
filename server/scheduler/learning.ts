import { listPublishedCourses } from '../db/courses.js'
import { getEmployee } from '../db/employees.js'
import { listDueQuizzes, setQuizNextRunAt } from '../db/quizzes.js'
import {
  getCourseAssignmentRow, getQuizAssignmentRow, listCourseOverdueCandidates, listCourseReminderCandidates,
  listQuizOverdueCandidates, listQuizReminderCandidates, markCourseReminderSent, markQuizReminderSent,
  setCourseAssignmentStatus, setQuizAssignmentStatus,
} from '../db/learningAssignments.js'
import { formatLocal } from '../lib/time.js'
import { assignCourse, issueQuiz } from '../learning/assign.js'
import { nextRun } from '../tasks/schedule.js'
import { continueCourseKeyboard, startQuizKeyboard } from '../bot/keyboards.js'
import { MISSED_SLOT_GRACE_MS } from './issueDue.js'
import type { SchedulerDeps } from './tick.js'

const DAY = 24 * 60 * 60_000

export async function assignCourses(deps: SchedulerDeps, now: Date): Promise<number> {
  let count = 0
  for (const course of listPublishedCourses(deps.db)) {
    try {
      count += await assignCourse(deps, course, now, !course.assign_existing)
    } catch (err) {
      console.error('scheduler: course assignment failed', course.id, err)
    }
  }
  return count
}

export async function issueDueQuizzes(deps: SchedulerDeps, now: Date): Promise<number> {
  let issued = 0
  for (const quiz of listDueQuizzes(deps.db, now.toISOString())) {
    if (!quiz.schedule || !quiz.next_run_at) continue
    try {
      const slot = new Date(quiz.next_run_at)
      if (now.getTime() - slot.getTime() > MISSED_SLOT_GRACE_MS) {
        console.warn(`scheduler: skipping missed quiz slot ${quiz.next_run_at} for quiz ${quiz.id}`)
      } else {
        issued += await issueQuiz(deps, quiz, slot, now)
      }
      const from = new Date(Math.max(slot.getTime(), now.getTime() - MISSED_SLOT_GRACE_MS))
      setQuizNextRunAt(deps.db, quiz.id, nextRun(quiz.schedule, from, deps.tz).toISOString())
    } catch (err) {
      console.error('scheduler: quiz issue failed', quiz.id, err)
    }
  }
  return issued
}

export function courseReminderLeadMs(durationMs: number): number {
  return durationMs > 2 * DAY ? DAY : Math.floor(durationMs / 2)
}

export async function learningReminders(deps: SchedulerDeps, now: Date): Promise<number> {
  let sent = 0
  for (const a of listCourseReminderCandidates(deps.db, now.toISOString())) {
    try {
      const due = new Date(a.due_at)
      const lead = courseReminderLeadMs(due.getTime() - new Date(a.assigned_at).getTime())
      if (due.getTime() - now.getTime() > lead) continue
      markCourseReminderSent(deps.db, a.id, now.toISOString())
      const row = getCourseAssignmentRow(deps.db, a.id)
      const e = getEmployee(deps.db, a.employee_id)
      if (!row || !e?.telegram_id) continue
      const id = await deps.notifier.toEmployee(e.telegram_id, `Напоминание: курс «${row.title}» нужно пройти до ${formatLocal(due, deps.tz, now)}`, {
        keyboard: continueCourseKeyboard(a.id),
      })
      if (id !== null) sent++
    } catch (err) {
      console.error('scheduler: learningReminders failed for course', a.id, err)
    }
  }
  for (const a of listQuizReminderCandidates(deps.db, now.toISOString())) {
    try {
      const due = new Date(a.due_at)
      const lead = Math.floor((due.getTime() - new Date(a.assigned_at).getTime()) / 2)
      if (due.getTime() - now.getTime() > lead) continue
      markQuizReminderSent(deps.db, a.id, now.toISOString())
      const row = getQuizAssignmentRow(deps.db, a.id)
      const e = getEmployee(deps.db, a.employee_id)
      if (!row || !e?.telegram_id) continue
      const id = await deps.notifier.toEmployee(e.telegram_id, `Напоминание: тест «${row.title}» нужно пройти до ${formatLocal(due, deps.tz, now)}`, {
        keyboard: startQuizKeyboard(a.id, row.open_attempt_id ? 'Продолжить' : 'Начать'),
      })
      if (id !== null) sent++
    } catch (err) {
      console.error('scheduler: learningReminders failed for quiz', a.id, err)
    }
  }
  return sent
}

export async function learningOverdue(deps: SchedulerDeps, now: Date): Promise<number> {
  let count = 0
  for (const a of listCourseOverdueCandidates(deps.db, now.toISOString())) {
    try {
      setCourseAssignmentStatus(deps.db, a.id, 'overdue')
      count++
      const row = getCourseAssignmentRow(deps.db, a.id)
      const e = getEmployee(deps.db, a.employee_id)
      if (!row) continue
      if (e?.telegram_id) await deps.notifier.toEmployee(e.telegram_id, `Курс «${row.title}» просрочен. Пройдите его как можно скорее.`, { keyboard: continueCourseKeyboard(a.id) })
      await deps.notifier.toOwner(`${row.employee_name} просрочил(а) курс «${row.title}».`)
    } catch (err) {
      console.error('scheduler: learningOverdue failed for course', a.id, err)
    }
  }
  for (const a of listQuizOverdueCandidates(deps.db, now.toISOString())) {
    try {
      setQuizAssignmentStatus(deps.db, a.id, 'overdue')
      count++
      const row = getQuizAssignmentRow(deps.db, a.id)
      const e = getEmployee(deps.db, a.employee_id)
      if (!row) continue
      if (e?.telegram_id) await deps.notifier.toEmployee(e.telegram_id, `Тест «${row.title}» просрочен. Пройдите его как можно скорее.`, { keyboard: startQuizKeyboard(a.id) })
      await deps.notifier.toOwner(`${row.employee_name} просрочил(а) тест «${row.title}».`)
    } catch (err) {
      console.error('scheduler: learningOverdue failed for quiz', a.id, err)
    }
  }
  return count
}
