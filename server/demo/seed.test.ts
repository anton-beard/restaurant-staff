import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { listEmployees } from '../db/employees.js'
import { listPositions } from '../db/positions.js'
import { listTaskTemplates } from '../db/taskTemplates.js'
import { periodDaysBack, rating } from '../stats/metrics.js'
import { summary } from '../stats/summary.js'
import { seedDemo } from './seed.js'

const NOW = new Date('2026-09-10T14:00:00.000Z') // четверг
const TZ = 'Europe/Lisbon'

describe('seedDemo', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('creates positions, employees, templates and a month of history', () => {
    const result = seedDemo(db, NOW, TZ)
    expect(result).not.toBe('already_seeded')
    if (result === 'already_seeded') return
    expect(listPositions(db).map((p) => p.name).sort()).toEqual(['Администратор', 'Бариста', 'Повар'])
    expect(listEmployees(db)).toHaveLength(7)
    expect(listTaskTemplates(db)).toHaveLength(result.templates)
    expect(result.instances).toBeGreaterThan(100)
    const rows = rating(db, periodDaysBack(NOW, 30))
    const scored = rows.filter((r) => r.score !== null)
    expect(scored.length).toBe(6)
    expect(scored[0]!.place).toBe(1)
    expect(scored.some((r) => r.tasks.overdue > 0)).toBe(true)
    expect(scored.filter((r) => r.quiz.attempts > 0).length).toBeGreaterThanOrEqual(5)
    const s = summary(db, NOW, TZ)
    expect(s.week.issued).toBeGreaterThan(0)
    expect(s.learning.coursesInProgress + s.learning.coursesOverdue).toBeGreaterThan(0)
  })

  it('reuses existing positions and refuses to seed twice', () => {
    db.prepare("insert into positions (name) values ('Бариста')").run()
    seedDemo(db, NOW, TZ)
    expect(listPositions(db).filter((p) => p.name === 'Бариста')).toHaveLength(1)
    expect(seedDemo(db, NOW, TZ)).toBe('already_seeded')
    expect(listEmployees(db)).toHaveLength(7)
  })

  it('schedules future runs for templates and the weekly quiz', () => {
    seedDemo(db, NOW, TZ)
    for (const t of listTaskTemplates(db)) expect(new Date(t.next_run_at!).getTime()).toBeGreaterThan(NOW.getTime())
    const q = db.prepare("select next_run_at from quizzes where title = 'Меню недели'").get() as { next_run_at: string }
    expect(new Date(q.next_run_at).getTime()).toBeGreaterThan(NOW.getTime())
  })
})
