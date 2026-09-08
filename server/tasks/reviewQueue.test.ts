import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, getInstance } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, getSubmission } from '../db/taskSubmissions.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import type { ReviewInput, ReviewResult } from '../ai/photoReview.js'
import { createReviewQueue } from './reviewQueue.js'

const NOW = new Date('2026-09-07T19:00:00.000Z')
let db: Db
let log: Notification[]
let uploadsDir: string
let templateId: number
let employeeId: number

// slot_at is offset per call: task_instances has a unique index on (template_id, slot_at, employee_id),
// so creating several submissions for the same employee/template in one test needs distinct slots.
let slotOffset = 0
function submission(): number {
  const slotAt = new Date(NOW.getTime() + slotOffset++).toISOString()
  const inst = createInstance(db, { template_id: templateId, employee_id: employeeId, slot_at: slotAt, issued_at: NOW.toISOString(), due_at: NOW.toISOString(), status: 'submitted' })!
  const rel = join(String(inst.id), '1.jpg')
  mkdirSync(join(uploadsDir, String(inst.id)), { recursive: true })
  writeFileSync(join(uploadsDir, rel), 'jpeg')
  return createSubmission(db, inst.id, NOW.toISOString(), [{ path: rel, fileUniqueId: `u${inst.id}` }]).id
}

beforeEach(() => {
  db = openDb(':memory:')
  const seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  log = []
  uploadsDir = mkdtempSync(join(tmpdir(), 'rq-'))
  slotOffset = 0
  employeeId = seed.employees.ivan.id
  templateId = createTaskTemplate(db, {
    title: 'Убрать стулья с улицы', description: '', requires_photo: true, photo_criteria: 'Стульев на улице нет',
    auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60,
    position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null).id
})

const queueWith = (reviewer: (i: ReviewInput) => Promise<ReviewResult>, concurrency = 2) =>
  createReviewQueue({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow', uploadsDir, reviewer, concurrency, now: () => NOW })

describe('review queue', () => {
  it('auto-accepts above the threshold and tells the employee', async () => {
    let seen: ReviewInput | undefined
    const q = queueWith(async (i) => { seen = i; return { score: 92, verdict: 'Всё убрано', issues: [] } })
    const id = submission()
    q.enqueue(id)
    await q.idle()
    expect(seen?.photos).toHaveLength(1)
    expect(seen?.criteria).toBe('Стульев на улице нет')
    expect(getSubmission(db, id)).toMatchObject({ ai_status: 'done', ai_attempts: 1, ai_score: 92, decision: 'auto_accepted' })
    expect(getInstance(db, getSubmission(db, id)!.instance_id)?.status).toBe('accepted')
    expect(log).toEqual([{ to: 500, text: expect.stringContaining('92') }])
  })

  it('sends low scores to the owner with photos', async () => {
    const q = queueWith(async () => ({ score: 40, verdict: 'Два стула остались', issues: ['стулья у входа'] }))
    const id = submission()
    q.enqueue(id)
    await q.idle()
    expect(getSubmission(db, id)?.decision).toBe('needs_review')
    expect(getInstance(db, getSubmission(db, id)!.instance_id)?.status).toBe('review')
    expect(log.find((n) => n.to === 500)?.text).toContain('владельцу')
    expect(log.find((n) => n.to === 'owner')?.text).toContain('стулья у входа')
  })

  it('marks failures and still routes to the owner', async () => {
    const q = queueWith(async () => { throw new Error('boom') })
    const id = submission()
    q.enqueue(id)
    await q.idle()
    expect(getSubmission(db, id)).toMatchObject({ ai_status: 'failed', decision: 'needs_review', ai_attempts: 1 })
    expect(log.find((n) => n.to === 'owner')?.text).toContain('ИИ недоступен')
  })

  it('skips already decided submissions and limits concurrency', async () => {
    let running = 0
    let peak = 0
    const q = queueWith(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return { score: 90, verdict: 'ok', issues: [] }
    })
    const ids = [submission(), submission(), submission()]
    ids.forEach((id) => q.enqueue(id))
    await q.idle()
    expect(peak).toBe(2)
    const before = log.length
    q.enqueue(ids[0]!)
    await q.idle()
    expect(log.length).toBe(before)
    expect(getSubmission(db, ids[0]!)?.ai_attempts).toBe(1)
  })

  it('falls back to a text notification when the photo album cannot be sent', async () => {
    const id = submission()
    const q = createReviewQueue({
      db,
      notifier: { ...fakeNotifier(log), photosToOwner: async () => false },
      tz: 'Europe/Moscow',
      uploadsDir,
      reviewer: async () => ({ score: 30, verdict: 'Плохо', issues: [] }),
      now: () => NOW,
    })
    q.enqueue(id)
    await q.idle()
    expect(log.some((n) => n.to === 'owner' && n.text.includes('Проверка:'))).toBe(true)
  })

  it('does not call the model when no photo files exist', async () => {
    let called = 0
    const q = queueWith(async () => { called++; return { score: 90, verdict: 'ok', issues: [] } })
    const id = submission()
    const inst = getSubmission(db, id)!.instance_id
    rmSync(join(uploadsDir, String(inst)), { recursive: true, force: true })
    // файл удалён с диска, но запись фото осталась: помечаем как deleted, чтобы очередь его не читала
    db.prepare('update task_photos set deleted_at = ? where submission_id = ?').run(NOW.toISOString(), id)
    q.enqueue(id)
    await q.idle()
    expect(called).toBe(0)
    expect(getSubmission(db, id)).toMatchObject({ ai_status: 'failed', decision: 'needs_review' })
    expect(log.some((n) => n.to === 'owner' && n.text.includes('ИИ недоступен'))).toBe(true)
  })

  it('ignores enqueue for a submission that is being processed', async () => {
    let calls = 0
    const q = queueWith(async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { score: 90, verdict: 'ok', issues: [] } })
    const id = submission()
    q.enqueue(id)
    await new Promise((r) => setTimeout(r, 5))
    q.enqueue(id)
    await q.idle()
    expect(calls).toBe(1)
  })

  it('enqueue reports whether the id was accepted', async () => {
    const q = queueWith(async () => ({ score: 90, verdict: 'ok', issues: [] }))
    const id = submission()
    expect(q.enqueue(id)).toBe(true)
    expect(q.enqueue(id)).toBe(false)
    await q.idle()
    // сдача уже решена, но принять в очередь можно — process() сам её пропустит
    expect(q.enqueue(id)).toBe(true)
    await q.idle()
  })
})
