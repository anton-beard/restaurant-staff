import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createTaskTemplate, type TaskTemplateInput } from '../db/taskTemplates.js'
import { listInstances, listOffers } from '../db/taskInstances.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { issueTemplate } from './issue.js'

let db: Db
let seed: ReturnType<typeof seedRestaurant>
let log: Notification[]
const now = new Date('2026-09-07T19:00:00.000Z')

const input = (over: Partial<TaskTemplateInput>): TaskTemplateInput => ({
  title: 'Убрать стулья с улицы',
  description: '',
  requires_photo: true,
  photo_criteria: 'Стульев на улице нет',
  auto_accept_threshold: 80,
  assignee_mode: 'by_position',
  distribution: 'each',
  schedule: null,
  deadline_minutes: 60,
  position_ids: [],
  employee_ids: [],
  ...over,
})

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  log = []
})

describe('issueTemplate', () => {
  it('each: one pending instance per eligible employee, each notified with an Open button', async () => {
    const t = createTaskTemplate(db, input({ position_ids: [seed.positions.barista.id] }), null)
    const r = await issueTemplate({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' }, t, now, now)
    expect(r.created).toHaveLength(2)
    expect(r.notified).toBe(2)
    expect(r.created[0]).toMatchObject({ status: 'pending', due_at: '2026-09-07T20:00:00.000Z', slot_at: now.toISOString() })
    expect(log.map((n) => n.to).sort()).toEqual([500, 501])
    expect(log[0]!.text).toContain('Убрать стулья с улицы')
    expect(log[0]!.text).toContain('до 23:00')
  })

  it('each: re-issuing the same slot creates nothing', async () => {
    const t = createTaskTemplate(db, input({ position_ids: [seed.positions.barista.id] }), null)
    const deps = { db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' }
    await issueTemplate(deps, t, now, now)
    const again = await issueTemplate(deps, t, now, now)
    expect(again.created).toEqual([])
    expect(again.notified).toBe(0)
    expect(listInstances(db, {})).toHaveLength(2)
  })

  it('shared: one open instance and an offer per employee', async () => {
    const t = createTaskTemplate(db, input({ distribution: 'shared', position_ids: [seed.positions.barista.id] }), null)
    const r = await issueTemplate({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' }, t, now, now)
    expect(r.created).toHaveLength(1)
    expect(r.created[0]).toMatchObject({ status: 'open', employee_id: null })
    expect(listOffers(db, r.created[0]!.id).map((o) => o.telegram_id).sort()).toEqual([500, 501])
    expect(log[0]!.text).toMatch(/Кто возьмёт/)
  })

  it('does nothing when nobody is eligible', async () => {
    const t = createTaskTemplate(db, input({ assignee_mode: 'by_employees', employee_ids: [seed.employees.olga.id] }), null)
    const r = await issueTemplate({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' }, t, now, now)
    expect(r).toEqual({ created: [], notified: 0 })
  })
})
