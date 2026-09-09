import type { Db } from '../db/connect.js'
import { localParts } from '../lib/time.js'
import { periodDaysBack, quizMetrics, rating, taskMetrics } from './metrics.js'

const two = (n: number) => String(n).padStart(2, '0')
const ddmm = (d: Date, tz: string) => {
  const p = localParts(d, tz)
  return `${two(p.d)}.${two(p.m)}`
}

export function digestText(db: Db, now: Date, tz: string): string {
  const week = periodDaysBack(now, 7)
  const issued = (db.prepare('select count(*) c from task_instances where issued_at >= ? and issued_at < ?').get(week.from, week.to) as { c: number }).c
  const t = taskMetrics(db, null, week)
  const q = quizMetrics(db, null, week)
  const courses = (db.prepare('select count(*) c from course_assignments where completed_at >= ? and completed_at < ?').get(week.from, week.to) as { c: number }).c
  const rows = rating(db, periodDaysBack(now, 30))
  const lines = [
    `Итоги недели ${ddmm(new Date(week.from), tz)}–${ddmm(now, tz)}`,
    `Задания: выдано ${issued}, в срок ${t.onTime}, поздно ${t.late}, просрочено ${t.overdue}`,
    `Тесты: сдано ${q.passed}, провалено ${q.failed}`,
    `Курсов завершено ${courses}`,
    '',
    'Рейтинг за 30 дней:',
    ...rows.map((r) =>
      r.score === null
        ? `— ${r.full_name}: нет данных`
        : `${r.place}. ${r.full_name}: ${r.score} (в срок ${r.tasks.onTime} из ${r.tasks.total}, тесты ${r.quiz.avgScore ?? '—'})`,
    ),
  ]
  return lines.join('\n')
}
