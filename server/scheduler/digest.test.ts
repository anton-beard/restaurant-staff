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

  it('marks the day as attempted even when the send fails, and never retries the same Monday', async () => {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    let calls = 0
    const failingDeps: SchedulerDeps = {
      ...deps,
      notifier: {
        ...deps.notifier,
        toOwner: async (text) => {
          calls++
          log.push({ to: 'owner', text })
          return null
        },
      },
    }
    expect(await weeklyDigest(failingDeps, MONDAY)).toBe(false)
    expect(calls).toBe(1)
    expect(getSetting(db, WEEKLY_DIGEST_SENT_FOR)).toBe('2026-09-07')
    expect(await weeklyDigest(failingDeps, new Date('2026-09-07T07:00:00.000Z'))).toBe(false)
    expect(calls).toBe(1)
  })
})
