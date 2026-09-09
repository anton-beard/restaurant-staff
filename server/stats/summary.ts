import type { Db } from '../db/connect.js'
import { localMidnight } from '../lib/time.js'
import { periodDaysBack, quizMetrics, taskMetrics, type Period } from './metrics.js'

export type PeriodStats = { issued: number; onTime: number; late: number; overdue: number; quizzesPassed: number; quizzesFailed: number }
export type Summary = {
  today: PeriodStats
  week: PeriodStats
  queue: { awaitingAi: number; awaitingOwner: number }
  learning: { coursesInProgress: number; coursesOverdue: number }
}

function periodStats(db: Db, period: Period): PeriodStats {
  const issued = (db.prepare('select count(*) c from task_instances where issued_at >= ? and issued_at < ?').get(period.from, period.to) as { c: number }).c
  const t = taskMetrics(db, null, period)
  const q = quizMetrics(db, null, period)
  return { issued, onTime: t.onTime, late: t.late, overdue: t.overdue, quizzesPassed: q.passed, quizzesFailed: q.failed }
}

const count = (db: Db, sql: string): number => (db.prepare(sql).get() as { c: number }).c

export function summary(db: Db, now: Date, tz: string): Summary {
  const todayFrom = localMidnight(now, tz).toISOString()
  const to = now.toISOString()
  return {
    today: periodStats(db, { from: todayFrom, to }),
    week: periodStats(db, periodDaysBack(now, 7)),
    queue: {
      awaitingAi: count(db, "select count(*) c from task_submissions where ai_status = 'pending'"),
      awaitingOwner: count(db, "select count(*) c from task_submissions where decision = 'needs_review'"),
    },
    learning: {
      coursesInProgress: count(db, "select count(*) c from course_assignments where status = 'in_progress'"),
      coursesOverdue: count(db, "select count(*) c from course_assignments where status = 'overdue'"),
    },
  }
}
