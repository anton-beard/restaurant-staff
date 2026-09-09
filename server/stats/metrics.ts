import type { Db } from '../db/connect.js'

export type Period = { from: string; to: string }

export function periodDaysBack(now: Date, days: number): Period {
  return { from: new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString(), to: now.toISOString() }
}

export type TaskMetrics = { total: number; onTime: number; late: number; overdue: number; onTimeShare: number | null }

export function taskMetrics(db: Db, employeeId: number | null, period: Period): TaskMetrics {
  const r = db
    .prepare(
      `select count(*) as total,
         sum(case when status = 'accepted' and completed_at is not null and completed_at <= due_at then 1 else 0 end) as onTime,
         sum(case when status = 'accepted' and (completed_at is null or completed_at > due_at) then 1 else 0 end) as late,
         sum(case when status = 'overdue' then 1 else 0 end) as overdue
       from task_instances
       where status in ('accepted', 'overdue') and due_at >= ? and due_at < ? and (? is null or employee_id = ?)`,
    )
    .get(period.from, period.to, employeeId, employeeId) as { total: number; onTime: number | null; late: number | null; overdue: number | null }
  const total = r.total
  const onTime = r.onTime ?? 0
  return { total, onTime, late: r.late ?? 0, overdue: r.overdue ?? 0, onTimeShare: total === 0 ? null : onTime / total }
}

export type QuizMetrics = { attempts: number; avgScore: number | null; passed: number; failed: number }

export function quizMetrics(db: Db, employeeId: number | null, period: Period): QuizMetrics {
  const r = db
    .prepare(
      `select count(*) as attempts, avg(t.score) as avgScore,
         sum(case when t.passed = 1 then 1 else 0 end) as passed,
         sum(case when t.passed = 0 then 1 else 0 end) as failed
       from quiz_attempts t join quiz_assignments a on a.id = t.assignment_id
       where t.finished_at is not null and t.score is not null
         and t.id = (select max(t2.id) from quiz_attempts t2 where t2.assignment_id = t.assignment_id and t2.finished_at is not null and t2.score is not null)
         and t.finished_at >= ? and t.finished_at < ?
         and (? is null or a.employee_id = ?)`,
    )
    .get(period.from, period.to, employeeId, employeeId) as { attempts: number; avgScore: number | null; passed: number | null; failed: number | null }
  return {
    attempts: r.attempts,
    avgScore: r.avgScore === null ? null : Math.round(r.avgScore),
    passed: r.passed ?? 0,
    failed: r.failed ?? 0,
  }
}

export function computeScore(onTimeShare: number | null, avgQuiz: number | null): number | null {
  if (onTimeShare === null && avgQuiz === null) return null
  if (onTimeShare === null) return Math.round(avgQuiz!)
  if (avgQuiz === null) return Math.round(onTimeShare * 100)
  return Math.round(0.6 * onTimeShare * 100 + 0.4 * avgQuiz)
}

export type EmployeeMetrics = { tasks: TaskMetrics; quiz: QuizMetrics; score: number | null }

export function employeeMetrics(db: Db, employeeId: number, period: Period): EmployeeMetrics {
  const tasks = taskMetrics(db, employeeId, period)
  const quiz = quizMetrics(db, employeeId, period)
  return { tasks, quiz, score: computeScore(tasks.onTimeShare, quiz.avgScore) }
}

export type RatingRow = EmployeeMetrics & { employee_id: number; full_name: string; position_name: string; place: number | null }

export function rating(db: Db, period: Period): RatingRow[] {
  const employees = db
    .prepare(`select e.id, e.full_name, p.name as position_name from employees e join positions p on p.id = e.position_id where e.status = 'active' order by e.full_name`)
    .all() as { id: number; full_name: string; position_name: string }[]
  const rows = employees.map((e) => ({ employee_id: e.id, full_name: e.full_name, position_name: e.position_name, place: null as number | null, ...employeeMetrics(db, e.id, period) }))
  rows.sort((a, b) => {
    if (a.score === null || b.score === null) return a.score === null ? (b.score === null ? a.full_name.localeCompare(b.full_name, 'ru') : 1) : -1
    if (b.score !== a.score) return b.score - a.score
    const sa = a.tasks.onTimeShare ?? -1
    const sb = b.tasks.onTimeShare ?? -1
    if (sb !== sa) return sb - sa
    return a.full_name.localeCompare(b.full_name, 'ru')
  })
  let place = 0
  rows.forEach((r, i) => {
    if (r.score === null) return
    const prev = rows[i - 1]
    if (!prev || prev.score !== r.score) place = i + 1
    r.place = place
  })
  return rows
}
