import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createInstance, getInstance, listInstances } from '../db/taskInstances.js'
import { createTaskTemplate, getTaskTemplate, type TaskTemplateInput } from '../db/taskTemplates.js'
import { createSubmission, getSubmission, markAiStarted } from '../db/taskSubmissions.js'
import { createOwnerAuth } from '../auth/ownerAuth.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { createScheduler, type SchedulerDeps } from './tick.js'
import { issueDueTemplates } from './issueDue.js'
import { sendReminders } from './reminders.js'
import { markOverdue } from './overdue.js'
import { retryStaleReviews } from './retryReviews.js'
import { cleanup } from './cleanup.js'

let db: Db
let seed: ReturnType<typeof seedRestaurant>
let log: Notification[]
let enqueued: number[]
let deps: SchedulerDeps
const T = (iso: string) => new Date(iso)

const tpl = (over: Partial<TaskTemplateInput> = {}): TaskTemplateInput => ({
  title: 'Помыть кофемашину', description: '', requires_photo: true, photo_criteria: 'Чисто', auto_accept_threshold: 80,
  assignee_mode: 'by_position', distribution: 'each', schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['22:00'] },
  deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [], ...over,
})

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  log = []
  enqueued = []
  deps = { db, notifier: fakeNotifier(log), tz: 'Europe/Moscow', uploadsDir: mkdtempSync(join(tmpdir(), 'sch-')), reviewQueue: { enqueue: (id) => enqueued.push(id) } }
})

describe('issueDueTemplates', () => {
  it('issues a due slot and advances next_run_at', async () => {
    const t = createTaskTemplate(db, tpl(), '2026-09-07T19:00:00.000Z')
    expect(await issueDueTemplates(deps, T('2026-09-07T19:00:30.000Z'))).toBe(2)
    expect(listInstances(db, {}).every((i) => i.slot_at === '2026-09-07T19:00:00.000Z' && i.due_at === '2026-09-07T20:00:00.000Z')).toBe(true)
    expect(getTaskTemplate(db, t.id)?.next_run_at).toBe('2026-09-08T19:00:00.000Z')
    expect(await issueDueTemplates(deps, T('2026-09-07T19:01:30.000Z'))).toBe(0)
  })

  it('skips a slot missed by more than an hour', async () => {
    const t = createTaskTemplate(db, tpl(), '2026-09-07T19:00:00.000Z')
    expect(await issueDueTemplates(deps, T('2026-09-07T20:30:00.000Z'))).toBe(0)
    expect(listInstances(db, {})).toEqual([])
    expect(getTaskTemplate(db, t.id)?.next_run_at).toBe('2026-09-08T19:00:00.000Z')
  })

  it('ignores one-off templates', async () => {
    createTaskTemplate(db, tpl({ schedule: null }), null)
    expect(await issueDueTemplates(deps, T('2026-09-07T19:00:30.000Z'))).toBe(0)
  })
})

describe('reminders', () => {
  it('reminds once, 2h before for long tasks and at half time for short ones', async () => {
    const long = createTaskTemplate(db, tpl({ deadline_minutes: 480 }), null)
    const short = createTaskTemplate(db, tpl({ deadline_minutes: 60 }), null)
    createInstance(db, { template_id: long.id, employee_id: seed.employees.ivan.id, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T18:00:00.000Z', status: 'pending' })
    createInstance(db, { template_id: short.id, employee_id: seed.employees.anna.id, slot_at: '2026-09-07T15:30:00.000Z', issued_at: '2026-09-07T15:30:00.000Z', due_at: '2026-09-07T16:30:00.000Z', status: 'pending' })
    expect(await sendReminders(deps, T('2026-09-07T15:50:00.000Z'))).toBe(0)
    expect(await sendReminders(deps, T('2026-09-07T16:01:00.000Z'))).toBe(2)
    expect(log.map((n) => n.to).sort()).toEqual([500, 501])
    expect(log[0]!.text).toMatch(/Напоминание/)
    expect(await sendReminders(deps, T('2026-09-07T16:05:00.000Z'))).toBe(0)
  })
})

describe('overdue', () => {
  it('marks pending and open instances and notifies', async () => {
    const t = createTaskTemplate(db, tpl(), null)
    const p = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'pending' })!
    const o = createInstance(db, { template_id: t.id, employee_id: null, slot_at: '2026-09-07T09:00:00.000Z', issued_at: '2026-09-07T09:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'open' })!
    expect(await markOverdue(deps, T('2026-09-07T11:01:00.000Z'))).toBe(2)
    expect(getInstance(db, p.id)?.status).toBe('overdue')
    expect(getInstance(db, o.id)?.status).toBe('overdue')
    expect(log.filter((n) => n.to === 500)).toHaveLength(1)
    expect(log.filter((n) => n.to === 'owner').map((n) => n.text).join(' ')).toMatch(/Никто не взял/)
    expect(await markOverdue(deps, T('2026-09-07T11:02:00.000Z'))).toBe(0)
  })
})

describe('retryStaleReviews', () => {
  it('re-enqueues stale pending reviews and fails after 3 attempts', async () => {
    const t = createTaskTemplate(db, tpl(), null)
    const i1 = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'submitted' })!
    const i2 = createInstance(db, { template_id: t.id, employee_id: seed.employees.anna.id, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'submitted' })!
    const fresh = createSubmission(db, i1.id, '2026-09-07T10:59:00.000Z', [{ path: 'a.jpg', fileUniqueId: 'u1' }])
    const stale = createSubmission(db, i2.id, '2026-09-07T10:50:00.000Z', [{ path: 'b.jpg', fileUniqueId: 'u2' }])
    expect(await retryStaleReviews(deps, T('2026-09-07T11:00:00.000Z'))).toEqual({ retried: 1, failed: 0 })
    expect(enqueued).toEqual([stale.id])
    expect(getSubmission(db, fresh.id)?.ai_status).toBe('pending')
    markAiStarted(db, stale.id)
    markAiStarted(db, stale.id)
    markAiStarted(db, stale.id)
    // к 11:10 свежая сдача тоже устарела и уходит на повтор, а исчерпавшая попытки помечается failed
    expect(await retryStaleReviews(deps, T('2026-09-07T11:10:00.000Z'))).toEqual({ retried: 1, failed: 1 })
    expect(enqueued).toEqual([stale.id, fresh.id])
    expect(getSubmission(db, stale.id)).toMatchObject({ ai_status: 'failed', decision: 'needs_review' })
    expect(getInstance(db, i2.id)?.status).toBe('review')
    expect(log.some((n) => n.to === 'owner' && n.text.includes('ИИ недоступен'))).toBe(true)
  })
})

describe('cleanup', () => {
  it('deletes old photo files, keeps rows, purges expired sessions and used codes', async () => {
    const t = createTaskTemplate(db, tpl(), null)
    const i = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: '2026-05-01T10:00:00.000Z', issued_at: '2026-05-01T10:00:00.000Z', due_at: '2026-05-01T11:00:00.000Z', status: 'accepted' })!
    mkdirSync(join(deps.uploadsDir, String(i.id)), { recursive: true })
    const rel = join(String(i.id), 'old.jpg')
    writeFileSync(join(deps.uploadsDir, rel), 'x')
    const s = createSubmission(db, i.id, '2026-05-01T10:30:00.000Z', [{ path: rel, fileUniqueId: 'u1' }])
    let clock = Date.parse('2026-09-07T10:00:00.000Z')
    const auth = createOwnerAuth(db, () => clock)
    const code = auth.createLoginCode() as string
    const { token } = auth.verifyLoginCode(code) as { token: string }
    clock += 31 * 24 * 60 * 60_000
    const r = await cleanup(deps, new Date(clock))
    expect(r).toEqual({ photos: 1, sessions: 1, codes: 1 })
    expect(existsSync(join(deps.uploadsDir, rel))).toBe(false)
    expect(getSubmission(db, s.id)).not.toBeNull()
    expect(auth.hasSession(token)).toBe(false)
  })
})

describe('tick', () => {
  it('runs the remaining steps even when an earlier step throws', async () => {
    // выдача упадёт на первом же уведомлении сотруднику, просрочка общего задания всё равно должна отработать
    const t = createTaskTemplate(db, tpl(), '2026-09-07T19:00:00.000Z')
    const o = createInstance(db, { template_id: t.id, employee_id: null, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'open' })!
    const throwing = { ...fakeNotifier(log), toEmployee: async () => { throw new Error('telegram down') } }
    const s = createScheduler({ ...deps, notifier: throwing, now: () => T('2026-09-07T19:00:30.000Z') })
    await s.tick()
    expect(getInstance(db, o.id)?.status).toBe('overdue')
    expect(log.some((n) => n.to === 'owner' && /Никто не взял/.test(n.text))).toBe(true)
  })
})
