# Этап 4: сводка, рейтинг, карточка сотрудника. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец видит сводку, рейтинг и карточку сотрудника в админке и получает недельный дайджест в боте; сотрудник видит свой балл и место.

**Architecture:** Модуль `server/stats/` с чистыми SQL-запросами по существующим таблицам (без таблиц статистики); индексы миграцией `004_stats`. API `/api/stats/*` и настройка дайджеста поверх него. Бот и планировщик используют те же функции. Админка получает стартовую страницу «Сводка» и карточку сотрудника.

**Tech Stack:** как в этапах 1–3; новых зависимостей нет.

Спек: `docs/superpowers/specs/2026-09-09-stage4-stats-design.md`. Паттерны: `db` первым аргументом, zod через `parse()`, тесты рядом с кодом, `buildTestApp` для API, `makeBot` + `handleUpdate` для бота, `fakeNotifier`, `seedRestaurant` (Иван 500 и Анна 501 бариста, Пётр 502 повар, Ольга без Telegram), `seedCourse`/`seedQuiz`.

## Global Constraints

- Node.js ≥ 24, ESM, TypeScript strict, `verbatimModuleSyntax`.
- Балл: `round(0.6 × onTimeShare × 100 + 0.4 × avgQuiz)`; при отсутствии одного слагаемого второе с весом 100%; без обоих `null`.
- Задания считаются по `due_at` в периоде `[from, to)` и только со статусами `accepted`/`overdue`; «в срок» = `accepted` и `completed_at <= due_at`.
- Тесты: последняя завершённая попытка (`finished_at` не null, `score` не null, максимальный `id`) каждого назначения с `finished_at` в периоде.
- Рейтинг: только активные сотрудники; сортировка `score desc, onTimeShare desc, full_name`; ничьи делят место; `score = null` в конце без места.
- Периоды: 7 / 30 / 90 дней в админке, 30 в боте; «сегодня» от локальной полуночи по `TZ`.
- Дайджест: понедельник по `TZ`, время из `settings.weekly_digest_time` (по умолчанию `09:00`), один раз (`settings.weekly_digest_sent_for` = дата понедельника), не догоняется во вторник, не отправляется без владельца.
- Все `/api/stats/*` и `/api/settings/*` за сессией владельца. Тексты на русском.
- Коммиты от локального автора, без remote/push, сообщения заканчиваются строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `.env` не читать и не коммитить.

## Структура файлов

```
server/db/migrations.ts            + 004_stats (индексы)
server/db/settings.ts              + ключи дайджеста
server/lib/time.ts                 + localMidnight, ymdLocal
server/stats/metrics.ts            periodDaysBack, taskMetrics, quizMetrics, computeScore, employeeMetrics, rating
server/stats/summary.ts            summary (сегодня / 7 дней / очередь / обучение)
server/stats/employeeCard.ts       история сотрудника
server/stats/digest.ts             digestText
server/api/stats.ts                /api/stats/*, /api/settings/digest
server/bot/rating.ts               «Мой рейтинг»
server/bot/roles.ts                summaryText с сегодняшними цифрами и топ-3
server/scheduler/digest.ts         weeklyDigest
admin/src/pages/DashboardPage.vue, EmployeePage.vue; api.ts, router.ts, AppLayout.vue, EmployeesPage.vue
```

---

### Task 1: Индексы и модуль метрик

**Files:**
- Modify: `server/db/migrations.ts` (+ `004_stats`), `server/lib/time.ts`, `server/lib/time.test.ts`
- Create: `server/stats/metrics.ts`, `server/stats/metrics.test.ts`, `server/stats/summary.ts`, `server/stats/summary.test.ts`, `server/stats/employeeCard.ts`, `server/stats/employeeCard.test.ts`

**Interfaces:**
- `time.ts` += `localMidnight(now: Date, tz: string): Date` (начало локального дня в UTC) и `ymdLocal(date: Date, tz: string): string` (`YYYY-MM-DD` локально).
- `metrics.ts`:
  ```ts
  type Period = { from: string; to: string }                       // ISO, [from, to)
  periodDaysBack(now: Date, days: number): Period
  type TaskMetrics = { total: number; onTime: number; late: number; overdue: number; onTimeShare: number | null }
  taskMetrics(db, employeeId: number | null, period): TaskMetrics   // null = все сотрудники
  type QuizMetrics = { attempts: number; avgScore: number | null; passed: number; failed: number }
  quizMetrics(db, employeeId: number | null, period): QuizMetrics
  computeScore(onTimeShare: number | null, avgQuiz: number | null): number | null
  type EmployeeMetrics = { tasks: TaskMetrics; quiz: QuizMetrics; score: number | null }
  employeeMetrics(db, employeeId, period): EmployeeMetrics
  type RatingRow = EmployeeMetrics & { employee_id: number; full_name: string; position_name: string; place: number | null }
  rating(db, period): RatingRow[]
  ```
- `summary.ts`:
  ```ts
  type PeriodStats = { issued: number; onTime: number; late: number; overdue: number; quizzesPassed: number; quizzesFailed: number }
  type Summary = { today: PeriodStats; week: PeriodStats; queue: { awaitingAi: number; awaitingOwner: number }; learning: { coursesInProgress: number; coursesOverdue: number } }
  summary(db, now: Date, tz: string): Summary
  ```
- `employeeCard.ts`:
  ```ts
  type TaskHistoryRow = { id; title; due_at; status; completed_at; last_score: number | null }
  type EmployeeCard = { employee: Employee; position_name: string; metrics: EmployeeMetrics; tasks: TaskHistoryRow[]; courses: CourseAssignmentRow[]; quizzes: (QuizAssignmentRow & { attempts: QuizAttempt[] })[] }
  employeeCard(db, employeeId, period): EmployeeCard | null
  ```

- [ ] **Step 1: Миграция и время**

В `migrations` добавить:
```ts
  {
    name: '004_stats',
    sql: `
      create index task_instances_employee_due on task_instances(employee_id, due_at);
      create index task_instances_issued on task_instances(issued_at);
      create index quiz_attempts_assignment_finished on quiz_attempts(assignment_id, finished_at);
      create index course_assignments_employee on course_assignments(employee_id);
      create index quiz_assignments_employee on quiz_assignments(employee_id);
    `,
  },
```

`server/lib/time.ts` добавить:
```ts
export function localMidnight(now: Date, tz: string): Date {
  const p = localParts(now, tz)
  return zonedToUtc({ y: p.y, m: p.m, d: p.d, hh: 0, mm: 0 }, tz)
}

export function ymdLocal(date: Date, tz: string): string {
  const p = localParts(date, tz)
  return `${p.y}-${two(p.m)}-${two(p.d)}`
}
```
(`two` уже есть в файле.) Тест в `server/lib/time.test.ts`:
```ts
  it('localMidnight and ymdLocal use the zone', () => {
    // 22:30Z 7 сентября = 01:30 8 сентября по Москве
    const t = new Date('2026-09-07T22:30:00Z')
    expect(localMidnight(t, MSK).toISOString()).toBe('2026-09-07T21:00:00.000Z')
    expect(ymdLocal(t, MSK)).toBe('2026-09-08')
    expect(ymdLocal(t, 'UTC')).toBe('2026-09-07')
  })
```
Run: `npx vitest run server/lib/time.test.ts server/db/connect.test.ts` → все passed.

- [ ] **Step 2: Тесты метрик**

`server/stats/metrics.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createAttempt, createQuizAssignment, finishAttempt, abandonAttempt } from '../db/learningAssignments.js'
import { archiveEmployee } from '../db/employees.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedQuiz } from '../test/learning.js'
import { computeScore, employeeMetrics, periodDaysBack, quizMetrics, rating, taskMetrics } from './metrics.js'

const NOW = new Date('2026-09-07T10:00:00.000Z')
const P = periodDaysBack(NOW, 30)
let db: Db
let seed: ReturnType<typeof seedRestaurant>
let templateId: number

function instance(employeeId: number, due: string, status: 'accepted' | 'overdue' | 'pending', completed?: string) {
  const i = createInstance(db, { template_id: templateId, employee_id: employeeId, slot_at: due, issued_at: due, due_at: due, status: 'pending' })!
  if (status !== 'pending') setInstanceStatus(db, i.id, status, { completed_at: completed ?? null })
  return i
}

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  templateId = createTaskTemplate(db, {
    title: 'Убрать стулья', description: '', requires_photo: false, photo_criteria: null, auto_accept_threshold: 80,
    assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null).id
})

describe('periodDaysBack', () => {
  it('spans exactly N days ending now', () => {
    expect(periodDaysBack(NOW, 7)).toEqual({ from: '2026-08-31T10:00:00.000Z', to: NOW.toISOString() })
  })
})

describe('taskMetrics', () => {
  it('counts on time, late and overdue by due_at within the period, ignoring unresolved', () => {
    const ivan = seed.employees.ivan.id
    instance(ivan, '2026-09-01T12:00:00.000Z', 'accepted', '2026-09-01T11:00:00.000Z')
    instance(ivan, '2026-09-02T12:00:00.000Z', 'accepted', '2026-09-02T13:00:00.000Z')
    instance(ivan, '2026-09-03T12:00:00.000Z', 'overdue')
    instance(ivan, '2026-09-04T12:00:00.000Z', 'pending')
    instance(ivan, '2026-07-01T12:00:00.000Z', 'accepted', '2026-07-01T11:00:00.000Z')
    instance(seed.employees.anna.id, '2026-09-05T12:00:00.000Z', 'accepted', '2026-09-05T11:00:00.000Z')
    expect(taskMetrics(db, ivan, P)).toEqual({ total: 3, onTime: 1, late: 1, overdue: 1, onTimeShare: 1 / 3 })
    expect(taskMetrics(db, null, P)).toMatchObject({ total: 4, onTime: 2 })
    expect(taskMetrics(db, seed.employees.petr.id, P)).toEqual({ total: 0, onTime: 0, late: 0, overdue: 0, onTimeShare: null })
  })
})

describe('quizMetrics', () => {
  it('uses the last finished attempt per assignment and ignores abandoned ones', () => {
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const ivan = seed.employees.ivan.id
    const a1 = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: ivan, course_assignment_id: null, slot_at: '2026-09-01T07:00:00.000Z', assigned_at: '2026-09-01T07:00:00.000Z', due_at: '2026-09-01T15:00:00.000Z' })!
    const t1 = createAttempt(db, a1.id, '2026-09-01T08:00:00.000Z')
    finishAttempt(db, t1.id, 50, false, '2026-09-01T08:10:00.000Z')
    const t2 = createAttempt(db, a1.id, '2026-09-01T09:00:00.000Z')
    finishAttempt(db, t2.id, 100, true, '2026-09-01T09:10:00.000Z')
    const a2 = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: ivan, course_assignment_id: null, slot_at: '2026-09-02T07:00:00.000Z', assigned_at: '2026-09-02T07:00:00.000Z', due_at: '2026-09-02T15:00:00.000Z' })!
    const t3 = createAttempt(db, a2.id, '2026-09-02T08:00:00.000Z')
    finishAttempt(db, t3.id, 60, false, '2026-09-02T08:10:00.000Z')
    const t4 = createAttempt(db, a2.id, '2026-09-02T09:00:00.000Z')
    abandonAttempt(db, t4.id, '2026-09-02T09:05:00.000Z')
    expect(quizMetrics(db, ivan, P)).toEqual({ attempts: 2, avgScore: 80, passed: 1, failed: 1 })
    expect(quizMetrics(db, seed.employees.anna.id, P)).toEqual({ attempts: 0, avgScore: null, passed: 0, failed: 0 })
    expect(quizMetrics(db, null, P).attempts).toBe(2)
  })
})

describe('computeScore', () => {
  it('weights 60/40, falls back to one component, null without data', () => {
    expect(computeScore(0.5, 90)).toBe(66)
    expect(computeScore(1, null)).toBe(100)
    expect(computeScore(null, 70)).toBe(70)
    expect(computeScore(null, null)).toBeNull()
  })
})

describe('rating', () => {
  it('ranks active employees, shares places on ties, puts no-data last', () => {
    const { ivan, anna, petr, olga } = seed.employees
    instance(ivan.id, '2026-09-01T12:00:00.000Z', 'accepted', '2026-09-01T11:00:00.000Z')
    instance(anna.id, '2026-09-01T12:00:00.000Z', 'accepted', '2026-09-01T11:00:00.000Z')
    instance(petr.id, '2026-09-01T12:00:00.000Z', 'overdue')
    archiveEmployee(db, olga.id)
    const rows = rating(db, P)
    expect(rows.map((r) => [r.full_name, r.score, r.place])).toEqual([
      ['Анна Смирнова', 100, 1],
      ['Иван Петров', 100, 1],
      ['Пётр Кузнецов', 0, 3],
    ])
    expect(rows[0]).toMatchObject({ position_name: 'Бариста', tasks: { total: 1, onTime: 1 } })
    const m = employeeMetrics(db, petr.id, P)
    expect(m).toMatchObject({ score: 0, tasks: { overdue: 1 }, quiz: { attempts: 0 } })
  })

  it('lists employees without data at the end without a place', () => {
    const rows = rating(db, P)
    expect(rows.every((r) => r.score === null && r.place === null)).toBe(true)
    expect(rows.map((r) => r.full_name)).toEqual(['Анна Смирнова', 'Иван Петров', 'Пётр Кузнецов'])
  })
})
```

Run: `npx vitest run server/stats/metrics.test.ts` → FAIL (модуль не найден).

- [ ] **Step 3: server/stats/metrics.ts**

```ts
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
    if (!prev || prev.score !== r.score || (prev.tasks.onTimeShare ?? -1) !== (r.tasks.onTimeShare ?? -1)) place = i + 1
    r.place = place
  })
  return rows
}
```

Run: `npx vitest run server/stats/metrics.test.ts` → все passed.

- [ ] **Step 4: Тест и код сводки**

`server/stats/summary.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, saveAiResult } from '../db/taskSubmissions.js'
import { createCourseAssignment, setCourseAssignmentStatus } from '../db/learningAssignments.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse } from '../test/learning.js'
import { summary } from './summary.js'

// понедельник 7 сентября, 13:00 по Москве
const NOW = new Date('2026-09-07T10:00:00.000Z')
let db: Db
let seed: ReturnType<typeof seedRestaurant>

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
})

describe('summary', () => {
  it('splits today (local midnight) from the week and counts queues and learning', () => {
    const t = createTaskTemplate(db, {
      title: 'Кофемашина', description: '', requires_photo: true, photo_criteria: 'Чисто', auto_accept_threshold: 80,
      assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
    }, null)
    const mk = (employeeId: number, issued: string, due: string) =>
      createInstance(db, { template_id: t.id, employee_id: employeeId, slot_at: issued, issued_at: issued, due_at: due, status: 'pending' })!
    // сегодня по Москве началось в 21:00Z 6 сентября
    const todayOk = mk(seed.employees.ivan.id, '2026-09-06T22:00:00.000Z', '2026-09-07T01:00:00.000Z')
    setInstanceStatus(db, todayOk.id, 'accepted', { completed_at: '2026-09-07T00:30:00.000Z' })
    const yesterdayLate = mk(seed.employees.anna.id, '2026-09-06T10:00:00.000Z', '2026-09-06T12:00:00.000Z')
    setInstanceStatus(db, yesterdayLate.id, 'overdue')
    const waiting = mk(seed.employees.ivan.id, '2026-09-07T08:00:00.000Z', '2026-09-07T12:00:00.000Z')
    setInstanceStatus(db, waiting.id, 'submitted')
    createSubmission(db, waiting.id, '2026-09-07T09:00:00.000Z', [{ path: 'a.jpg', fileUniqueId: 'u1' }])
    const review = mk(seed.employees.petr.id, '2026-09-07T08:00:00.000Z', '2026-09-07T12:00:00.000Z')
    setInstanceStatus(db, review.id, 'review')
    const s = createSubmission(db, review.id, '2026-09-07T09:00:00.000Z', [{ path: 'b.jpg', fileUniqueId: 'u2' }])
    saveAiResult(db, s.id, { score: 40, verdict: 'x', issues: [] }, 'needs_review', '2026-09-07T09:01:00.000Z')
    const { course } = seedCourse(db, [seed.positions.barista.id])
    createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-10T10:00:00.000Z' })
    const late = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.anna.id, assigned_at: '2026-08-20T10:00:00.000Z', due_at: '2026-09-01T10:00:00.000Z' })!
    setCourseAssignmentStatus(db, late.id, 'overdue')

    const r = summary(db, NOW, 'Europe/Moscow')
    expect(r.today).toMatchObject({ issued: 3, onTime: 1, late: 0, overdue: 0 })
    expect(r.week).toMatchObject({ issued: 4, onTime: 1, overdue: 1 })
    expect(r.queue).toEqual({ awaitingAi: 1, awaitingOwner: 1 })
    expect(r.learning).toEqual({ coursesInProgress: 1, coursesOverdue: 1 })
  })
})
```

`server/stats/summary.ts`:
```ts
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
```

Run: `npx vitest run server/stats/summary.test.ts` → 1 passed.

- [ ] **Step 5: Карточка сотрудника**

`server/stats/employeeCard.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, saveAiResult } from '../db/taskSubmissions.js'
import { createAttempt, createCourseAssignment, createQuizAssignment, finishAttempt } from '../db/learningAssignments.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import { periodDaysBack } from './metrics.js'
import { employeeCard } from './employeeCard.js'

const NOW = new Date('2026-09-07T10:00:00.000Z')
let db: Db
let seed: ReturnType<typeof seedRestaurant>

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
})

describe('employeeCard', () => {
  it('returns metrics and history for the employee, null for unknown', () => {
    const ivan = seed.employees.ivan.id
    const t = createTaskTemplate(db, {
      title: 'Кофемашина', description: '', requires_photo: true, photo_criteria: 'Чисто', auto_accept_threshold: 80,
      assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
    }, null)
    const i = createInstance(db, { template_id: t.id, employee_id: ivan, slot_at: '2026-09-01T10:00:00.000Z', issued_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-01T11:00:00.000Z', status: 'pending' })!
    setInstanceStatus(db, i.id, 'accepted', { completed_at: '2026-09-01T10:30:00.000Z' })
    const s = createSubmission(db, i.id, '2026-09-01T10:20:00.000Z', [{ path: 'a.jpg', fileUniqueId: 'u1' }])
    saveAiResult(db, s.id, { score: 91, verdict: 'ok', issues: [] }, 'auto_accepted', '2026-09-01T10:30:00.000Z')
    const { course } = seedCourse(db, [seed.positions.barista.id])
    createCourseAssignment(db, { course_id: course.id, employee_id: ivan, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-08T10:00:00.000Z' })
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const qa = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: ivan, course_assignment_id: null, slot_at: '2026-09-02T07:00:00.000Z', assigned_at: '2026-09-02T07:00:00.000Z', due_at: '2026-09-02T15:00:00.000Z' })!
    const a = createAttempt(db, qa.id, '2026-09-02T08:00:00.000Z')
    finishAttempt(db, a.id, 100, true, '2026-09-02T08:10:00.000Z')

    const card = employeeCard(db, ivan, periodDaysBack(NOW, 30))!
    expect(card.employee.full_name).toBe('Иван Петров')
    expect(card.position_name).toBe('Бариста')
    expect(card.metrics).toMatchObject({ score: 100, tasks: { onTime: 1 }, quiz: { avgScore: 100 } })
    expect(card.tasks).toEqual([{ id: i.id, title: 'Кофемашина', due_at: '2026-09-01T11:00:00.000Z', status: 'accepted', completed_at: '2026-09-01T10:30:00.000Z', last_score: 91 }])
    expect(card.courses[0]).toMatchObject({ title: 'Эспрессо по стандарту', current_lesson: 1 })
    expect(card.quizzes[0]).toMatchObject({ title: 'Меню недели' })
    expect(card.quizzes[0]!.attempts[0]).toMatchObject({ score: 100, passed: true })
    expect(employeeCard(db, 999, periodDaysBack(NOW, 30))).toBeNull()
  })
})
```

`server/stats/employeeCard.ts`:
```ts
import type { Db } from '../db/connect.js'
import { getEmployee, type Employee } from '../db/employees.js'
import {
  listAttempts, listCourseAssignments, listQuizAssignments, type CourseAssignmentRow, type QuizAssignmentRow, type QuizAttempt,
} from '../db/learningAssignments.js'
import { employeeMetrics, type EmployeeMetrics, type Period } from './metrics.js'

export type TaskHistoryRow = { id: number; title: string; due_at: string; status: string; completed_at: string | null; last_score: number | null }
export type EmployeeCard = {
  employee: Employee
  position_name: string
  metrics: EmployeeMetrics
  tasks: TaskHistoryRow[]
  courses: CourseAssignmentRow[]
  quizzes: (QuizAssignmentRow & { attempts: QuizAttempt[] })[]
}

export function employeeCard(db: Db, employeeId: number, period: Period): EmployeeCard | null {
  const employee = getEmployee(db, employeeId)
  if (!employee) return null
  const position_name = (db.prepare('select name from positions where id = ?').get(employee.position_id) as { name: string } | undefined)?.name ?? '—'
  const tasks = db
    .prepare(
      `select i.id, t.title, i.due_at, i.status, i.completed_at,
         (select s.ai_score from task_submissions s where s.instance_id = i.id order by s.id desc limit 1) as last_score
       from task_instances i join task_templates t on t.id = i.template_id
       where i.employee_id = ? and i.due_at >= ? and i.due_at < ? order by i.due_at desc`,
    )
    .all(employeeId, period.from, period.to) as TaskHistoryRow[]
  const courses = listCourseAssignments(db, { employee_id: employeeId })
  const quizzes = listQuizAssignments(db, { employee_id: employeeId }).map((q) => ({ ...q, attempts: listAttempts(db, q.id) }))
  return { employee, position_name, metrics: employeeMetrics(db, employeeId, period), tasks, courses, quizzes }
}
```

Run: `npx vitest run server/stats` → все passed.

- [ ] **Step 6: Всё зелёное, commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add server/db/migrations.ts server/lib/time.ts server/lib/time.test.ts server/stats
git commit -m "feat: stats module with task/quiz metrics, rating, summary and employee card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: API статистики и настройка дайджеста

**Files:**
- Modify: `server/db/settings.ts` (ключи), `server/app.ts` (регистрация)
- Create: `server/api/stats.ts`, `server/api/stats.test.ts`

**Interfaces:**
- `settings.ts` += `WEEKLY_DIGEST_TIME = 'weekly_digest_time'`, `WEEKLY_DIGEST_SENT_FOR = 'weekly_digest_sent_for'`, `DEFAULT_DIGEST_TIME = '09:00'`, `getDigestTime(db): string` (настройка или дефолт).
- HTTP (за сессией): `GET /api/stats/summary` → `Summary`; `GET /api/stats/rating?days=7|30|90` (по умолчанию 30) → `RatingRow[]`; `GET /api/stats/employees/:id?days=` → `EmployeeCard` / 404; `GET /api/settings/digest` → `{ time: 'HH:MM' }`; `PUT /api/settings/digest` `{ time }` → `{ time }` (400 при неверном формате).

- [ ] **Step 1: Тесты**

`server/api/stats.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'

async function setup() {
  const t = await buildTestApp()
  const seed = seedRestaurant(t.db)
  const cookie = await t.loginAsOwner()
  const tpl = createTaskTemplate(t.db, {
    title: 'Кофемашина', description: '', requires_photo: false, photo_criteria: null, auto_accept_threshold: 80,
    assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null)
  const due = new Date(Date.now() - 60 * 60_000).toISOString()
  const i = createInstance(t.db, { template_id: tpl.id, employee_id: seed.employees.ivan.id, slot_at: due, issued_at: due, due_at: due, status: 'pending' })!
  setInstanceStatus(t.db, i.id, 'accepted', { completed_at: due })
  return { ...t, seed, h: { cookie } }
}

describe('stats api', () => {
  it('serves summary, rating and the employee card', async () => {
    const { app, seed, h } = await setup()
    const s = await app.inject({ method: 'GET', url: '/api/stats/summary', headers: h })
    expect(s.statusCode).toBe(200)
    expect(s.json().week).toMatchObject({ issued: 1, onTime: 1 })
    expect(s.json().queue).toEqual({ awaitingAi: 0, awaitingOwner: 0 })

    const r = await app.inject({ method: 'GET', url: '/api/stats/rating?days=7', headers: h })
    expect(r.json()[0]).toMatchObject({ full_name: 'Иван Петров', score: 100, place: 1 })
    expect((await app.inject({ method: 'GET', url: '/api/stats/rating?days=5', headers: h })).statusCode).toBe(400)

    const c = await app.inject({ method: 'GET', url: `/api/stats/employees/${seed.employees.ivan.id}?days=30`, headers: h })
    expect(c.json()).toMatchObject({ position_name: 'Бариста', metrics: { score: 100 } })
    expect(c.json().tasks).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url: '/api/stats/employees/999', headers: h })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/stats/summary' })).statusCode).toBe(401)
  })

  it('reads and writes the digest time', async () => {
    const { app, h } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/settings/digest', headers: h })).json()).toEqual({ time: '09:00' })
    const put = await app.inject({ method: 'PUT', url: '/api/settings/digest', headers: h, payload: { time: '08:30' } })
    expect(put.json()).toEqual({ time: '08:30' })
    expect((await app.inject({ method: 'GET', url: '/api/settings/digest', headers: h })).json()).toEqual({ time: '08:30' })
    expect((await app.inject({ method: 'PUT', url: '/api/settings/digest', headers: h, payload: { time: '25:00' } })).statusCode).toBe(400)
  })
})
```

Run: `npx vitest run server/api/stats.test.ts` → FAIL.

- [ ] **Step 2: settings.ts и роуты**

`server/db/settings.ts` добавить:
```ts
export const WEEKLY_DIGEST_TIME = 'weekly_digest_time'
export const WEEKLY_DIGEST_SENT_FOR = 'weekly_digest_sent_for'
export const DEFAULT_DIGEST_TIME = '09:00'

export function getDigestTime(db: Db): string {
  return getSetting(db, WEEKLY_DIGEST_TIME) ?? DEFAULT_DIGEST_TIME
}
```

`server/api/stats.ts`:
```ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import { getDigestTime, setSetting, WEEKLY_DIGEST_TIME } from '../db/settings.js'
import { idParams, parse } from '../lib/validate.js'
import { employeeCard } from '../stats/employeeCard.js'
import { periodDaysBack, rating } from '../stats/metrics.js'
import { summary } from '../stats/summary.js'

type Opts = { db: Db; tz: string; now?: () => Date }

const daysQuery = z.object({ days: z.enum(['7', '30', '90']).default('30') })
const digestBody = z.object({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ') })

export const statsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db, tz } = opts
  const now = opts.now ?? (() => new Date())

  app.get('/api/stats/summary', async () => summary(db, now(), tz))

  app.get('/api/stats/rating', async (req) => {
    const { days } = parse(daysQuery, req.query)
    return rating(db, periodDaysBack(now(), Number(days)))
  })

  app.get('/api/stats/employees/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const { days } = parse(daysQuery, req.query)
    return employeeCard(db, id, periodDaysBack(now(), Number(days))) ?? reply.code(404).send({ error: 'not_found' })
  })

  app.get('/api/settings/digest', async () => ({ time: getDigestTime(db) }))

  app.put('/api/settings/digest', async (req) => {
    const { time } = parse(digestBody, req.body)
    setSetting(db, WEEKLY_DIGEST_TIME, time)
    return { time }
  })
}
```

`server/app.ts`: импорт `statsRoutes` и в защищённом scope `scope.register(statsRoutes, { db, tz: config.TZ })`.

Run: `npx vitest run server/api/stats.test.ts` → 2 passed. Run: `npm test && npm run typecheck` → зелёные.

- [ ] **Step 3: Commit**

```bash
git add server/db/settings.ts server/api/stats.ts server/api/stats.test.ts server/app.ts
git commit -m "feat: stats API and weekly digest time setting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Бот: «Мой рейтинг» и расширенная «Сводка»

**Files:**
- Create: `server/bot/rating.ts`, `server/bot/rating.test.ts`
- Modify: `server/bot/roles.ts` (`summaryText`), `server/bot/linking.ts` (убрать заглушку `BTN.rating`), `server/bot/createBot.ts` (регистрация `registerRating` после `registerQuiz`), `server/bot/createBot.test.ts`

**Interfaces:**
- `ratingText(db, employeeId: number, now: Date): string` (экспорт из `rating.ts`):
  ```
  За 30 дней
  Балл: N            | Пока нет данных для рейтинга.
  Заданий в срок: X из Y   | Заданий пока не было.
  Тесты: средний балл Z    | Тестов пока не было.
  Место: K из M            (только при балле)
  ```
- `registerRating(bot, deps)`: `hears(BTN.rating)` для сотрудника (иначе `showHome`).
- `summaryText(db, publicUrl, now, tz)` получает четвёртый аргумент `tz` и добавляет строки `Сегодня: выдано A, в срок B, просрочено C` и `Топ за 30 дней: 1. Имя (балл), 2. …` (до трёх сотрудников с баллом; если никого, строка «Рейтинг: пока нет данных»). Вызовы в `linking.ts` передают `deps.tz`.

- [ ] **Step 1: Тесты**

`server/bot/rating.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { textUpdate, type ApiCall } from '../test/telegram.js'
import type { BotContext } from './states.js'

const NOW = new Date('2026-09-07T10:00:00.000Z')
let db: Db
let bot: Bot<BotContext>
let calls: ApiCall[]
let seed: ReturnType<typeof seedRestaurant>
const lastText = () => String(calls.filter((c) => c.method === 'sendMessage').at(-1)?.payload.text ?? '')

function accepted(employeeId: number, due: string, completed: string) {
  const t = createTaskTemplate(db, {
    title: 'Кофемашина', description: '', requires_photo: false, photo_criteria: null, auto_accept_threshold: 80,
    assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null)
  const i = createInstance(db, { template_id: t.id, employee_id: employeeId, slot_at: due, issued_at: due, due_at: due, status: 'pending' })!
  setInstanceStatus(db, i.id, 'accepted', { completed_at: completed })
}

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  ;({ bot, calls } = makeBot(db, { now: () => NOW }))
})

describe('my rating', () => {
  it('shows placeholders without data', async () => {
    await bot.handleUpdate(textUpdate(500, 'Мой рейтинг'))
    expect(lastText()).toContain('Пока нет данных для рейтинга.')
    expect(lastText()).toContain('Заданий пока не было.')
    expect(lastText()).toContain('Тестов пока не было.')
  })

  it('shows score, tasks and place', async () => {
    accepted(seed.employees.ivan.id, '2026-09-01T12:00:00.000Z', '2026-09-01T11:00:00.000Z')
    accepted(seed.employees.anna.id, '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z')
    await bot.handleUpdate(textUpdate(500, 'Мой рейтинг'))
    expect(lastText()).toContain('Балл: 100')
    expect(lastText()).toContain('Заданий в срок: 1 из 1')
    expect(lastText()).toContain('Место: 1 из 2')
    await bot.handleUpdate(textUpdate(501, 'Мой рейтинг'))
    expect(lastText()).toContain('Балл: 0')
    expect(lastText()).toContain('Место: 2 из 2')
  })
})

describe('owner summary', () => {
  it('includes today counters and the top 3', async () => {
    accepted(seed.employees.ivan.id, '2026-09-07T05:00:00.000Z', '2026-09-07T04:00:00.000Z')
    await bot.handleUpdate(textUpdate(42, 'Сводка'))
    expect(lastText()).toContain('Сегодня: выдано 1, в срок 1, просрочено 0')
    expect(lastText()).toContain('Топ за 30 дней: 1. Иван Петров (100)')
  })
})
```

Run: `npx vitest run server/bot/rating.test.ts` → FAIL.

- [ ] **Step 2: rating.ts, summaryText, регистрация**

`server/bot/rating.ts`:
```ts
import type { Bot } from 'grammy'
import type { Db } from '../db/connect.js'
import { employeeMetrics, periodDaysBack, rating } from '../stats/metrics.js'
import type { BotDeps } from './deps.js'
import { BTN, employeeMenu } from './keyboards.js'
import { showHome } from './linking.js'
import { employeeOf, type BotContext } from './states.js'

export function ratingText(db: Db, employeeId: number, now: Date): string {
  const period = periodDaysBack(now, 30)
  const m = employeeMetrics(db, employeeId, period)
  const lines = ['За 30 дней']
  lines.push(m.score === null ? 'Пока нет данных для рейтинга.' : `Балл: ${m.score}`)
  lines.push(m.tasks.total === 0 ? 'Заданий пока не было.' : `Заданий в срок: ${m.tasks.onTime} из ${m.tasks.total}`)
  lines.push(m.quiz.attempts === 0 ? 'Тестов пока не было.' : `Тесты: средний балл ${m.quiz.avgScore}`)
  if (m.score !== null) {
    const rows = rating(db, period).filter((r) => r.score !== null)
    const me = rows.find((r) => r.employee_id === employeeId)
    if (me?.place) lines.push(`Место: ${me.place} из ${rows.length}`)
  }
  return lines.join('\n')
}

export function registerRating(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.hears(BTN.rating, async (ctx) => {
    const emp = employeeOf(ctx)
    if (!emp) return showHome(ctx, deps)
    await ctx.reply(ratingText(deps.db, emp.id, deps.now()), { reply_markup: employeeMenu() })
  })
}
```

`server/bot/roles.ts`, `summaryText(db, publicUrl, now, tz)`:
```ts
import { periodDaysBack, rating } from '../stats/metrics.js'
import { summary } from '../stats/summary.js'

export function summaryText(db: Db, publicUrl: string | undefined, now: Date, tz: string): string {
  const all = listEmployees(db)
  const active = all.filter((e) => e.status === 'active').length
  const invited = all.filter((e) => e.status === 'invited').length
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString()
  const s = summary(db, now, tz)
  const top = rating(db, periodDaysBack(now, 30)).filter((r) => r.score !== null).slice(0, 3)
  const lines = [
    `Активны: ${active}`,
    `Приглашены: ${invited}`,
    `Сегодня: выдано ${s.today.issued}, в срок ${s.today.onTime}, просрочено ${s.today.overdue}`,
    `На проверке: ${s.queue.awaitingOwner}`,
    `Просрочено за сутки: ${countOverdueSince(db, dayAgo)}`,
    top.length ? `Топ за 30 дней: ${top.map((r, i) => `${i + 1}. ${r.full_name} (${r.score})`).join(', ')}` : 'Рейтинг: пока нет данных',
  ]
  if (publicUrl) lines.push(`Админка: ${publicUrl}`)
  return lines.join('\n')
}
```
(импорт `listReviewQueue` больше не нужен, удалить). В `server/bot/linking.ts` вызовы `summaryText(db, deps.publicUrl, deps.now())` → `summaryText(db, deps.publicUrl, deps.now(), deps.tz)`; заглушка `bot.hears(BTN.rating, …)` удаляется. В `createBot.ts` после `registerQuiz(bot, deps)` добавить `registerRating(bot, deps)`. В `createBot.test.ts` тест, нажимающий «Мой рейтинг» и ожидающий «появится», удалить (заглушек больше нет); тест сводки по-прежнему ищет `Приглашены: 1` и ссылку.

Run: `npx vitest run server/bot` → все passed.

- [ ] **Step 3: Commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add server/bot
git commit -m "feat(bot): employee rating and owner summary with today counters and top 3

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Недельный дайджест

**Files:**
- Create: `server/stats/digest.ts`, `server/scheduler/digest.ts`, `server/scheduler/digest.test.ts`
- Modify: `server/scheduler/tick.ts` (шаг `weeklyDigest` после `learningOverdue`)

**Interfaces:**
- `digestText(db, now: Date, tz: string): string` — «Итоги недели DD.MM–DD.MM» (прошлые 7 дней по `periodDaysBack(now, 7)`, даты локальные): «Задания: выдано A, в срок B, поздно C, просрочено D», «Тесты: сдано E, провалено F», «Курсов завершено G» (число `course_assignments` с `completed_at` в периоде), пустая строка, «Рейтинг за 30 дней:», затем строки `K. Имя: балл (в срок X из Y, тесты Z)` (Z = средний балл или «—»), сотрудники без данных «— Имя: нет данных».
- `weeklyDigest(deps: SchedulerDeps, now: Date): Promise<boolean>` — true, если отправлено. Условия: владелец привязан; `localParts(now, tz).weekday === 1`; локальное `HH:MM` ≥ `getDigestTime(db)`; `getSetting(WEEKLY_DIGEST_SENT_FOR) !== ymdLocal(now, tz)`. После успешной `toOwner` записывает `WEEKLY_DIGEST_SENT_FOR = ymdLocal(now, tz)`.

- [ ] **Step 1: Тест**

`server/scheduler/digest.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { getSetting, OWNER_TELEGRAM_ID, setSetting, WEEKLY_DIGEST_SENT_FOR, WEEKLY_DIGEST_TIME } from '../db/settings.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createCourseAssignment, completeCourseAssignment } from '../db/learningAssignments.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse } from '../test/learning.js'
import type { SchedulerDeps } from './tick.js'
import { weeklyDigest } from './digest.js'
import { digestText } from '../stats/digest.js'

// понедельник 7 сентября 2026, 09:30 по Москве
const MONDAY = new Date('2026-09-07T06:30:00.000Z')
let db: Db
let seed: ReturnType<typeof seedRestaurant>
let log: Notification[]
let deps: SchedulerDeps

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  log = []
  deps = { db, notifier: fakeNotifier(log), tz: 'Europe/Moscow', uploadsDir: '/tmp', reviewQueue: { enqueue: () => true, isActive: () => false } }
})

describe('digestText', () => {
  it('summarises the past week and the rating', () => {
    const t = createTaskTemplate(db, {
      title: 'Кофемашина', description: '', requires_photo: false, photo_criteria: null, auto_accept_threshold: 80,
      assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
    }, null)
    const i = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: '2026-09-03T10:00:00.000Z', issued_at: '2026-09-03T10:00:00.000Z', due_at: '2026-09-03T11:00:00.000Z', status: 'pending' })!
    setInstanceStatus(db, i.id, 'accepted', { completed_at: '2026-09-03T10:30:00.000Z' })
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const ca = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.anna.id, assigned_at: '2026-08-25T10:00:00.000Z', due_at: '2026-09-05T10:00:00.000Z' })!
    completeCourseAssignment(db, ca.id, '2026-09-04T10:00:00.000Z')
    const text = digestText(db, MONDAY, 'Europe/Moscow')
    expect(text).toContain('Итоги недели 31.08–07.09')
    expect(text).toContain('Задания: выдано 1, в срок 1, поздно 0, просрочено 0')
    expect(text).toContain('Тесты: сдано 0, провалено 0')
    expect(text).toContain('Курсов завершено 1')
    expect(text).toContain('1. Иван Петров: 100 (в срок 1 из 1, тесты —)')
    expect(text).toContain('— Анна Смирнова: нет данных')
  })
})

describe('weeklyDigest', () => {
  it('sends once on Monday after the configured time, never without an owner', async () => {
    expect(await weeklyDigest(deps, MONDAY)).toBe(false)
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    expect(await weeklyDigest(deps, new Date('2026-09-07T05:30:00.000Z'))).toBe(false) // 08:30, раньше 09:00
    expect(await weeklyDigest(deps, MONDAY)).toBe(true)
    expect(log[0]).toMatchObject({ to: 'owner', text: expect.stringContaining('Итоги недели') })
    expect(getSetting(db, WEEKLY_DIGEST_SENT_FOR)).toBe('2026-09-07')
    expect(await weeklyDigest(deps, new Date('2026-09-07T07:00:00.000Z'))).toBe(false)
    expect(log).toHaveLength(1)
    expect(await weeklyDigest(deps, new Date('2026-09-08T06:30:00.000Z'))).toBe(false) // вторник
    setSetting(db, WEEKLY_DIGEST_TIME, '12:00')
    expect(await weeklyDigest(deps, new Date('2026-09-14T06:30:00.000Z'))).toBe(false) // 09:30 < 12:00
    expect(await weeklyDigest(deps, new Date('2026-09-14T09:30:00.000Z'))).toBe(true)
  })
})
```

Run: `npx vitest run server/scheduler/digest.test.ts` → FAIL.

- [ ] **Step 2: Код**

`server/stats/digest.ts`:
```ts
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
```

`server/scheduler/digest.ts`:
```ts
import { getDigestTime, getSetting, OWNER_TELEGRAM_ID, setSetting, WEEKLY_DIGEST_SENT_FOR } from '../db/settings.js'
import { localParts, ymdLocal } from '../lib/time.js'
import { digestText } from '../stats/digest.js'
import type { SchedulerDeps } from './tick.js'

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
  if (id === null) return false
  setSetting(db, WEEKLY_DIGEST_SENT_FOR, today)
  return true
}
```

`server/scheduler/tick.ts`: импорт и `await step('weeklyDigest', () => weeklyDigest(deps, t))` после `learningOverdue`.

Run: `npx vitest run server/scheduler` → все passed. Run: `npm test && npm run typecheck` → зелёные.

- [ ] **Step 3: Commit**

```bash
git add server/stats/digest.ts server/scheduler/digest.ts server/scheduler/digest.test.ts server/scheduler/tick.ts
git commit -m "feat(scheduler): weekly owner digest at a configurable Monday time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Админка: сводка и карточка сотрудника

**Files:**
- Modify: `admin/src/api.ts`, `admin/src/router.ts`, `admin/src/components/AppLayout.vue`, `admin/src/pages/EmployeesPage.vue`
- Create: `admin/src/pages/DashboardPage.vue`, `admin/src/pages/EmployeePage.vue`

**Interfaces:**
- Маршруты: `''` → `DashboardPage` (редирект `/` → `/tasks` убирается), `employees/:id` → `EmployeePage` (`props: true`). В шапке первый пункт «Сводка» (ссылка на `/`), слово «Ресторан» остаётся заголовком.
- `api.stats = { summary(), rating(days), employee(id, days) }`, `api.settings = { digest(), setDigest(time) }` с типами `Summary`, `RatingRow`, `EmployeeCard` по ответам сервера.
- В `EmployeesPage.vue` имя сотрудника становится `RouterLink` на `/employees/:id`.

- [ ] **Step 1: api.ts**

Добавить типы:
```ts
export type TaskMetrics = { total: number; onTime: number; late: number; overdue: number; onTimeShare: number | null }
export type QuizMetrics = { attempts: number; avgScore: number | null; passed: number; failed: number }
export type EmployeeMetrics = { tasks: TaskMetrics; quiz: QuizMetrics; score: number | null }
export type RatingRow = EmployeeMetrics & { employee_id: number; full_name: string; position_name: string; place: number | null }
export type PeriodStats = { issued: number; onTime: number; late: number; overdue: number; quizzesPassed: number; quizzesFailed: number }
export type Summary = { today: PeriodStats; week: PeriodStats; queue: { awaitingAi: number; awaitingOwner: number }; learning: { coursesInProgress: number; coursesOverdue: number } }
export type TaskHistoryRow = { id: number; title: string; due_at: string; status: InstanceStatus; completed_at: string | null; last_score: number | null }
export type EmployeeCard = { employee: Employee; position_name: string; metrics: EmployeeMetrics; tasks: TaskHistoryRow[]; courses: CourseAssignmentRow[]; quizzes: (QuizAssignmentRow & { attempts: QuizAttempt[] })[] }
export type RatingDays = 7 | 30 | 90
```
и методы в `api`:
```ts
  stats: {
    summary: () => request<Summary>('GET', '/api/stats/summary'),
    rating: (days: RatingDays) => request<RatingRow[]>('GET', `/api/stats/rating?days=${days}`),
    employee: (id: number, days: RatingDays) => request<EmployeeCard>('GET', `/api/stats/employees/${id}?days=${days}`),
  },
  settings: {
    digest: () => request<{ time: string }>('GET', '/api/settings/digest'),
    setDigest: (time: string) => request<{ time: string }>('PUT', '/api/settings/digest', { time }),
  },
```

- [ ] **Step 2: Роутер, шапка, ссылка из списка сотрудников**

`router.ts`: заменить `{ path: '', redirect: '/tasks' }` на `{ path: '', component: DashboardPage }` и добавить `{ path: 'employees/:id', component: EmployeePage, props: true }` перед `positions`.

`AppLayout.vue`: первым пунктом после названия `<RouterLink to="/" class="text-sm hover:underline" active-class="font-semibold" exact-active-class="font-semibold">Сводка</RouterLink>` (для корня `active-class` подсветит и вложенные пути, поэтому используйте `:class="{ 'font-semibold': $route.path === '/' }"` вместо `active-class`).

`EmployeesPage.vue`: ячейка имени → `<RouterLink :to="\`/employees/${e.id}\`" class="underline">{{ e.full_name }}</RouterLink>`.

- [ ] **Step 3: DashboardPage.vue**

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api, errorText, type RatingDays, type RatingRow, type Summary } from '../api'

const summary = ref<Summary | null>(null)
const rows = ref<RatingRow[]>([])
const days = ref<RatingDays>(30)
const digestTime = ref('09:00')
const error = ref('')
const info = ref('')

async function loadSummary() {
  try {
    summary.value = await api.stats.summary()
    digestTime.value = (await api.settings.digest()).time
  } catch (err) {
    error.value = errorText(err)
  }
}
async function loadRating() {
  try {
    rows.value = await api.stats.rating(days.value)
  } catch (err) {
    error.value = errorText(err)
  }
}
async function saveDigest() {
  error.value = ''
  info.value = ''
  try {
    await api.settings.setDigest(digestTime.value)
    info.value = `Недельная сводка будет приходить по понедельникам в ${digestTime.value}.`
  } catch (err) {
    error.value = errorText(err, { validation: 'Время в формате ЧЧ:ММ.' })
  }
}
const pct = (share: number | null) => (share === null ? '—' : `${Math.round(share * 100)}%`)

onMounted(() => {
  void loadSummary()
  void loadRating()
})
watch(days, loadRating)
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-xl font-semibold">Сводка</h1>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <div v-if="summary" class="grid gap-4 md:grid-cols-4 text-sm">
      <div class="bg-white rounded-xl shadow p-4">
        <div class="text-gray-500">Сегодня</div>
        <div class="text-2xl font-semibold">{{ summary.today.onTime }} <span class="text-base font-normal text-gray-500">в срок из {{ summary.today.issued }} выданных</span></div>
        <div :class="summary.today.overdue ? 'text-red-700' : 'text-gray-500'">Просрочено: {{ summary.today.overdue }}, поздно: {{ summary.today.late }}</div>
      </div>
      <div class="bg-white rounded-xl shadow p-4">
        <div class="text-gray-500">7 дней</div>
        <div class="text-2xl font-semibold">{{ summary.week.onTime }} <span class="text-base font-normal text-gray-500">в срок из {{ summary.week.issued }}</span></div>
        <div :class="summary.week.overdue ? 'text-red-700' : 'text-gray-500'">Просрочено: {{ summary.week.overdue }}, поздно: {{ summary.week.late }}</div>
      </div>
      <RouterLink to="/review" class="bg-white rounded-xl shadow p-4 hover:bg-gray-50">
        <div class="text-gray-500">Ждёт проверки</div>
        <div class="text-2xl font-semibold">{{ summary.queue.awaitingOwner }}</div>
        <div class="text-gray-500">Проверяет ИИ: {{ summary.queue.awaitingAi }}</div>
      </RouterLink>
      <div class="bg-white rounded-xl shadow p-4">
        <div class="text-gray-500">Обучение</div>
        <div>Курсов в процессе: {{ summary.learning.coursesInProgress }}</div>
        <div :class="summary.learning.coursesOverdue ? 'text-red-700' : ''">Курсов просрочено: {{ summary.learning.coursesOverdue }}</div>
        <div>Тестов за 7 дней: сдано {{ summary.week.quizzesPassed }}, провалено {{ summary.week.quizzesFailed }}</div>
      </div>
    </div>

    <section class="space-y-3">
      <div class="flex items-center gap-3">
        <h2 class="font-semibold">Рейтинг сотрудников</h2>
        <div class="flex gap-1">
          <button v-for="d in [7, 30, 90] as RatingDays[]" :key="d" class="btn-secondary" :class="{ 'bg-gray-900 text-white': days === d }" @click="days = d">{{ d }} дней</button>
        </div>
      </div>
      <table class="w-full bg-white rounded-xl shadow text-sm">
        <thead class="text-left text-gray-500">
          <tr><th class="px-4 py-2">#</th><th class="px-4 py-2">Сотрудник</th><th class="px-4 py-2">Должность</th><th class="px-4 py-2">Балл</th><th class="px-4 py-2">В срок</th><th class="px-4 py-2">Тесты</th><th class="px-4 py-2">Просрочек</th></tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="r in rows" :key="r.employee_id" :class="{ 'text-red-700': r.tasks.overdue > 0 }">
            <td class="px-4 py-2">{{ r.place ?? '—' }}</td>
            <td class="px-4 py-2"><RouterLink :to="`/employees/${r.employee_id}`" class="underline">{{ r.full_name }}</RouterLink></td>
            <td class="px-4 py-2">{{ r.position_name }}</td>
            <td class="px-4 py-2 font-semibold">{{ r.score ?? 'нет данных' }}</td>
            <td class="px-4 py-2">{{ r.tasks.total ? `${r.tasks.onTime} из ${r.tasks.total} (${pct(r.tasks.onTimeShare)})` : '—' }}</td>
            <td class="px-4 py-2">{{ r.quiz.avgScore ?? '—' }}</td>
            <td class="px-4 py-2">{{ r.tasks.overdue }}</td>
          </tr>
          <tr v-if="rows.length === 0"><td colspan="7" class="px-4 py-3 text-gray-500">Нет активных сотрудников</td></tr>
        </tbody>
      </table>
    </section>

    <section class="bg-white rounded-xl shadow p-4 text-sm space-y-2 max-w-md">
      <div class="font-medium">Недельная сводка в боте</div>
      <form class="flex gap-2 items-center" @submit.prevent="saveDigest">
        <span>По понедельникам в</span>
        <input v-model="digestTime" type="time" class="input max-w-32" required />
        <button class="btn">Сохранить</button>
      </form>
      <p v-if="info" class="text-green-700">{{ info }}</p>
    </section>
  </div>
</template>
```

- [ ] **Step 4: EmployeePage.vue**

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api, errorText, type EmployeeCard, type RatingDays } from '../api'
import { fmtDate, STATUS_LABEL } from '../lib/schedule'

const props = defineProps<{ id: string }>()
const card = ref<EmployeeCard | null>(null)
const days = ref<RatingDays>(30)
const tab = ref<'tasks' | 'courses' | 'quizzes'>('tasks')
const error = ref('')
const COURSE_STATUS: Record<string, string> = { in_progress: 'В процессе', completed: 'Завершён', overdue: 'Просрочен' }
const QUIZ_STATUS: Record<string, string> = { pending: 'Не сдан', passed: 'Сдан', overdue: 'Просрочен' }
const EMP_STATUS: Record<string, string> = { invited: 'Приглашён', active: 'Активен', archived: 'В архиве' }

async function load() {
  error.value = ''
  try {
    card.value = await api.stats.employee(Number(props.id), days.value)
  } catch (err) {
    error.value = errorText(err, { not_found: 'Сотрудник не найден.' })
  }
}
onMounted(load)
watch(days, load)
</script>

<template>
  <div class="space-y-4">
    <RouterLink to="/employees" class="text-sm text-gray-500 hover:underline">← Сотрудники</RouterLink>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <template v-if="card">
      <div class="flex items-baseline gap-3 flex-wrap">
        <h1 class="text-xl font-semibold">{{ card.employee.full_name }}</h1>
        <span class="text-gray-500">{{ card.position_name }} · {{ EMP_STATUS[card.employee.status] }} · {{ card.employee.telegram_id ? 'Telegram привязан' : 'Telegram не привязан' }}</span>
      </div>

      <div class="flex items-center gap-3 text-sm">
        <span>Период:</span>
        <button v-for="d in [7, 30, 90] as RatingDays[]" :key="d" class="btn-secondary" :class="{ 'bg-gray-900 text-white': days === d }" @click="days = d">{{ d }} дней</button>
      </div>
      <div class="grid gap-4 md:grid-cols-3 text-sm">
        <div class="bg-white rounded-xl shadow p-4"><div class="text-gray-500">Балл</div><div class="text-2xl font-semibold">{{ card.metrics.score ?? 'нет данных' }}</div></div>
        <div class="bg-white rounded-xl shadow p-4"><div class="text-gray-500">Задания в срок</div><div class="text-2xl font-semibold">{{ card.metrics.tasks.onTime }} из {{ card.metrics.tasks.total }}</div><div :class="card.metrics.tasks.overdue ? 'text-red-700' : 'text-gray-500'">Просрочено: {{ card.metrics.tasks.overdue }}, поздно: {{ card.metrics.tasks.late }}</div></div>
        <div class="bg-white rounded-xl shadow p-4"><div class="text-gray-500">Тесты</div><div class="text-2xl font-semibold">{{ card.metrics.quiz.avgScore ?? '—' }}</div><div class="text-gray-500">Сдано {{ card.metrics.quiz.passed }}, провалено {{ card.metrics.quiz.failed }}</div></div>
      </div>

      <div class="flex gap-2">
        <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'tasks' }" @click="tab = 'tasks'">Задания</button>
        <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'courses' }" @click="tab = 'courses'">Курсы</button>
        <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'quizzes' }" @click="tab = 'quizzes'">Тесты</button>
      </div>

      <table v-if="tab === 'tasks'" class="w-full bg-white rounded-xl shadow text-sm">
        <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Задание</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Выполнено</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2">ИИ</th></tr></thead>
        <tbody class="divide-y">
          <tr v-for="t in card.tasks" :key="t.id" :class="{ 'text-red-700': t.status === 'overdue' }">
            <td class="px-4 py-2">{{ t.title }}</td><td class="px-4 py-2">{{ fmtDate(t.due_at) }}</td><td class="px-4 py-2">{{ fmtDate(t.completed_at) }}</td>
            <td class="px-4 py-2">{{ STATUS_LABEL[t.status] }}</td><td class="px-4 py-2">{{ t.last_score ?? '—' }}</td>
          </tr>
          <tr v-if="card.tasks.length === 0"><td colspan="5" class="px-4 py-3 text-gray-500">Заданий за период нет</td></tr>
        </tbody>
      </table>

      <table v-else-if="tab === 'courses'" class="w-full bg-white rounded-xl shadow text-sm">
        <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Курс</th><th class="px-4 py-2">Урок</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Статус</th></tr></thead>
        <tbody class="divide-y">
          <tr v-for="c in card.courses" :key="c.id" :class="{ 'text-red-700': c.status === 'overdue' }">
            <td class="px-4 py-2">{{ c.title }}</td><td class="px-4 py-2">{{ Math.min(c.current_lesson, c.lesson_count) }} из {{ c.lesson_count }}</td>
            <td class="px-4 py-2">{{ fmtDate(c.due_at) }}</td><td class="px-4 py-2">{{ COURSE_STATUS[c.status] }}</td>
          </tr>
          <tr v-if="card.courses.length === 0"><td colspan="4" class="px-4 py-3 text-gray-500">Курсов нет</td></tr>
        </tbody>
      </table>

      <table v-else class="w-full bg-white rounded-xl shadow text-sm">
        <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Тест</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2">Попытки</th></tr></thead>
        <tbody class="divide-y">
          <tr v-for="q in card.quizzes" :key="q.id" :class="{ 'text-red-700': q.status === 'overdue' }">
            <td class="px-4 py-2">{{ q.title }}</td><td class="px-4 py-2">{{ fmtDate(q.due_at) }}</td><td class="px-4 py-2">{{ QUIZ_STATUS[q.status] }}</td>
            <td class="px-4 py-2">
              <span v-if="q.attempts.length === 0" class="text-gray-500">—</span>
              <span v-else>{{ q.attempts.map((a) => (a.finished_at ? `${a.score ?? '—'}${a.passed ? ' ✓' : ''}` : 'идёт')).join(', ') }}</span>
            </td>
          </tr>
          <tr v-if="card.quizzes.length === 0"><td colspan="4" class="px-4 py-3 text-gray-500">Тестов нет</td></tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
```

- [ ] **Step 5: Сборка и commit**

Run: `npm run build` → чисто. Run: `npm test` → зелёные.

```bash
git add admin
git commit -m "feat(admin): dashboard with summary, rating and digest setting; employee card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: README и ручной прогон

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

В «Что умеет» добавить:
```markdown
- Контроль: сводка за сегодня и неделю, рейтинг сотрудников за 7 / 30 / 90 дней (60% задания в срок, 40% тесты), карточка сотрудника с историей, «Мой рейтинг» в боте, недельная сводка владельцу по понедельникам (время настраивается в админке).
```
В строку про дизайн добавить ссылку на `docs/superpowers/specs/2026-09-09-stage4-stats-design.md`.

- [ ] **Step 2: Ручной прогон**

Собрать и запустить (`npm run build`, `set -a; source .env; set +a; npm start`), проверить:
1. Админка открывается на «Сводке»: карточки «Сегодня» / «7 дней» / «Ждёт проверки» / «Обучение», таблица рейтинга на накопленных данных, переключатель периода меняет цифры.
2. Клик по имени в рейтинге и из списка сотрудников открывает карточку с тремя вкладками.
3. Сохранение времени недельной сводки: поставить время через 2 минуты от текущего, если сегодня понедельник, и дождаться сообщения в боте; иначе проверить, что настройка сохраняется после перезагрузки страницы.
4. В боте: «Сводка» показывает «Сегодня: …» и «Топ за 30 дней»; со второго аккаунта «Мой рейтинг» показывает балл и место.

- [ ] **Step 3: Финальная проверка и commit**

Run: `npm test && npm run typecheck && npm run build` → зелёные.

```bash
git add README.md
git commit -m "docs: describe stage 4 (summary, rating, digest)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
