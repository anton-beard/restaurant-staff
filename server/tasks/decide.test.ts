import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, getInstance } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, getSubmission, saveAiResult, getReviewRow } from '../db/taskSubmissions.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { applyOwnerDecision, decideByScore, ownerReviewCaption } from './decide.js'

const NOW = '2026-09-07T19:00:00.000Z'
let db: Db
let log: Notification[]
let subId: number
let instId: number

beforeEach(() => {
  db = openDb(':memory:')
  const seed = seedRestaurant(db)
  log = []
  const t = createTaskTemplate(db, {
    title: 'Разобрать поставку кофе', description: '', requires_photo: true, photo_criteria: 'Коробки разобраны, пакеты на полке',
    auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60,
    position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null)
  instId = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'review' })!.id
  subId = createSubmission(db, instId, NOW, [{ path: 'a.jpg', fileUniqueId: 'u1' }]).id
  saveAiResult(db, subId, { score: 60, verdict: 'Часть коробок не разобрана', issues: ['коробки у входа'] }, 'needs_review', NOW)
})

describe('decideByScore', () => {
  it('accepts at or above the threshold only', () => {
    expect(decideByScore(80, 80)).toBe('auto_accepted')
    expect(decideByScore(79, 80)).toBe('needs_review')
    expect(decideByScore(100, 100)).toBe('auto_accepted')
  })
})

describe('applyOwnerDecision', () => {
  const deps = () => ({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' })

  it('accept closes the instance and tells the employee', async () => {
    const r = await applyOwnerDecision(deps(), subId, 'accept', null, new Date(NOW))
    expect(r).toEqual({ ok: true, instanceId: instId })
    expect(getSubmission(db, subId)).toMatchObject({ decision: 'owner_accepted', decided_at: NOW })
    expect(getInstance(db, instId)).toMatchObject({ status: 'accepted', completed_at: NOW })
    expect(log).toEqual([{ to: 500, text: expect.stringContaining('принято') }])
  })

  it('reject reopens the instance with the comment', async () => {
    const r = await applyOwnerDecision(deps(), subId, 'reject', 'Коробки у входа остались', new Date(NOW))
    expect(r.ok).toBe(true)
    expect(getSubmission(db, subId)).toMatchObject({ decision: 'owner_rejected', owner_comment: 'Коробки у входа остались' })
    expect(getInstance(db, instId)?.status).toBe('pending')
    expect(log[0]!.text).toContain('Коробки у входа остались')
  })

  it('second decision and unknown id are refused', async () => {
    await applyOwnerDecision(deps(), subId, 'accept', null, new Date(NOW))
    expect(await applyOwnerDecision(deps(), subId, 'reject', 'x', new Date(NOW))).toEqual({ ok: false, reason: 'already_decided' })
    expect(await applyOwnerDecision(deps(), 999, 'accept', null, new Date(NOW))).toEqual({ ok: false, reason: 'not_found' })
  })

  it('caption mentions task, employee, score and issues', () => {
    const cap = ownerReviewCaption(getReviewRow(db, subId)!)
    expect(cap).toContain('Разобрать поставку кофе')
    expect(cap).toContain('Иван Петров')
    expect(cap).toContain('60')
    expect(cap).toContain('коробки у входа')
    expect(cap.length).toBeLessThanOrEqual(1000)
  })
})
