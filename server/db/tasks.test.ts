import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './connect.js'
import { seedRestaurant } from '../test/fixtures.js'
import {
  createTaskTemplate, deleteTaskTemplate, eligibleEmployees, getTaskTemplate, listDueTemplates, listTaskTemplates,
  setTemplateActive, updateTaskTemplate, type TaskTemplateInput,
} from './taskTemplates.js'
import {
  addOffer, claimInstance, createInstance, getInstanceRow, listEmployeeInstances, listInstances,
  listOffers, listOverdueCandidates, listReminderCandidates, markReminderSent, setInstanceStatus,
} from './taskInstances.js'
import {
  createSubmission, getSubmission, listReviewQueue, listStaleAiPending, markAiFailed, markAiStarted,
  photoExists, saveAiResult, setOwnerDecision, listPhotosOlderThan, markPhotoDeleted,
} from './taskSubmissions.js'
import { clearState, getState, setState } from './botStates.js'

let db: Db
let seed: ReturnType<typeof seedRestaurant>
const NOW = '2026-09-07T10:00:00.000Z'

const baseInput: TaskTemplateInput = {
  title: 'Помыть кофемашину',
  description: 'Группы, холдеры, поддон',
  requires_photo: true,
  photo_criteria: 'Группы без кофейных остатков, поддон пустой',
  auto_accept_threshold: 80,
  assignee_mode: 'by_position',
  distribution: 'each',
  schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['22:00'] },
  deadline_minutes: 60,
  position_ids: [],
  employee_ids: [],
}

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
})

describe('task templates', () => {
  it('creates with links and reads back typed fields', () => {
    const t = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, '2026-09-07T19:00:00.000Z')
    expect(t).toMatchObject({ id: 1, requires_photo: true, active: true, next_run_at: '2026-09-07T19:00:00.000Z' })
    expect(t.schedule).toEqual(baseInput.schedule)
    expect(t.position_ids).toEqual([seed.positions.barista.id])
    expect(getTaskTemplate(db, 1)).toEqual(t)
  })

  it('updates links and schedule, lists active only by default', () => {
    createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null)
    const u = updateTaskTemplate(db, 1, { ...baseInput, assignee_mode: 'by_employees', employee_ids: [seed.employees.petr.id], schedule: null }, null)!
    expect(u.employee_ids).toEqual([seed.employees.petr.id])
    expect(u.position_ids).toEqual([])
    expect(u.schedule).toBeNull()
    setTemplateActive(db, 1, false, null)
    expect(listTaskTemplates(db)).toEqual([])
    expect(listTaskTemplates(db, { includeInactive: true })).toHaveLength(1)
  })

  it('resolves eligible employees: active by position or explicit', () => {
    const byPos = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id, seed.positions.admin.id] }, null)
    expect(eligibleEmployees(db, byPos).map((e) => e.full_name).sort()).toEqual(['Анна Смирнова', 'Иван Петров'])
    const explicit = createTaskTemplate(db, { ...baseInput, assignee_mode: 'by_employees', employee_ids: [seed.employees.petr.id, seed.employees.olga.id] }, null)
    expect(eligibleEmployees(db, explicit).map((e) => e.full_name)).toEqual(['Пётр Кузнецов'])
  })

  it('lists due templates', () => {
    createTaskTemplate(db, baseInput, '2026-09-07T09:59:00.000Z')
    createTaskTemplate(db, baseInput, '2026-09-07T10:01:00.000Z')
    createTaskTemplate(db, { ...baseInput, schedule: null }, null)
    expect(listDueTemplates(db, NOW).map((t) => t.id)).toEqual([1])
  })

  it('deletes a template without instances, refuses one with history', () => {
    const t = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null)
    const withHistory = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null)
    createInstance(db, { template_id: withHistory.id, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'pending' })
    expect(deleteTaskTemplate(db, withHistory.id)).toBe('has_instances')
    expect(deleteTaskTemplate(db, t.id)).toBe('deleted')
    expect(getTaskTemplate(db, t.id)).toBeNull()
    expect(db.prepare('select count(*) c from task_template_positions where template_id = ?').get(t.id)).toEqual({ c: 0 })
    expect(deleteTaskTemplate(db, 999)).toBe('not_found')
  })
})

describe('task instances', () => {
  let templateId: number
  beforeEach(() => {
    templateId = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null).id
  })

  it('creates, dedupes per employee and per shared slot', () => {
    const a = createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'pending' })
    expect(a?.status).toBe('pending')
    expect(createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'pending' })).toBeNull()
    expect(createInstance(db, { template_id: templateId, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'open' })).not.toBeNull()
    expect(createInstance(db, { template_id: templateId, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'open' })).toBeNull()
  })

  it('claims a shared instance once', () => {
    const shared = createInstance(db, { template_id: templateId, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'open' })!
    addOffer(db, shared.id, 500, 10)
    addOffer(db, shared.id, 501, 11)
    expect(claimInstance(db, shared.id, seed.employees.ivan.id, NOW)).toBe(true)
    expect(claimInstance(db, shared.id, seed.employees.anna.id, NOW)).toBe(false)
    expect(getInstanceRow(db, shared.id)).toMatchObject({ status: 'pending', employee_id: seed.employees.ivan.id, employee_name: 'Иван Петров', claimed_at: NOW })
    expect(listOffers(db, shared.id)).toEqual([{ telegram_id: 500, message_id: 10 }, { telegram_id: 501, message_id: 11 }])
  })

  it('lists for employee and with filters; row carries title and last score', () => {
    const i = createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: '2026-09-07T11:00:00.000Z', status: 'pending' })!
    createInstance(db, { template_id: templateId, employee_id: seed.employees.anna.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'accepted' })
    expect(listEmployeeInstances(db, seed.employees.ivan.id, ['pending', 'submitted', 'review'])).toHaveLength(1)
    expect(listInstances(db, { status: 'accepted' })).toHaveLength(1)
    expect(listInstances(db, { employee_id: seed.employees.ivan.id })[0]).toMatchObject({ title: 'Помыть кофемашину', requires_photo: true, last_score: null })
    const s = createSubmission(db, i.id, NOW, [{ path: 'p/1.jpg', fileUniqueId: 'u1' }])
    saveAiResult(db, s.id, { score: 91, verdict: 'ok', issues: [] }, 'auto_accepted', NOW)
    expect(listInstances(db, { employee_id: seed.employees.ivan.id })[0]!.last_score).toBe(91)
    expect(listInstances(db, { from: '2026-09-08T00:00:00.000Z' })).toEqual([])
  })

  it('reminder and overdue candidates', () => {
    const p = createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: '2026-09-07T11:00:00.000Z', status: 'pending' })!
    const late = createInstance(db, { template_id: templateId, employee_id: seed.employees.anna.id, slot_at: '2026-09-07T08:00:00.000Z', issued_at: NOW, due_at: '2026-09-07T09:00:00.000Z', status: 'pending' })!
    const o = createInstance(db, { template_id: templateId, employee_id: null, slot_at: '2026-09-07T08:00:00.000Z', issued_at: NOW, due_at: '2026-09-07T09:00:00.000Z', status: 'open' })!
    createInstance(db, { template_id: templateId, employee_id: seed.employees.petr.id, slot_at: NOW, issued_at: NOW, due_at: '2026-09-07T09:00:00.000Z', status: 'review' })
    // напоминание только для pending с дедлайном в будущем
    expect(listReminderCandidates(db, NOW).map((x) => x.id)).toEqual([p.id])
    markReminderSent(db, p.id, NOW)
    expect(listReminderCandidates(db, NOW)).toEqual([])
    // просрочка: pending и open с истёкшим дедлайном, review не трогаем
    expect(listOverdueCandidates(db, NOW).map((x) => x.id).sort()).toEqual([late.id, o.id].sort())
    setInstanceStatus(db, p.id, 'accepted', { completed_at: NOW })
    expect(getInstanceRow(db, p.id)).toMatchObject({ status: 'accepted', completed_at: NOW })
  })

  it('after a shared instance is claimed, the same employee cannot get an "each" copy for that slot', () => {
    const shared = createInstance(db, { template_id: templateId, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'open' })!
    expect(claimInstance(db, shared.id, seed.employees.ivan.id, NOW)).toBe(true)
    // (template, slot, employee) теперь занято экземпляром, который был общим
    expect(createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'pending' })).toBeNull()
    // а новый общий экземпляр на тот же слот снова возможен: партиальный индекс смотрит только на строки с employee_id null
    expect(createInstance(db, { template_id: templateId, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'open' })).not.toBeNull()
  })

  it('listInstances "to" is exclusive on issued_at', () => {
    createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: '2026-09-07T10:00:00.000Z', due_at: NOW, status: 'pending' })
    createInstance(db, { template_id: templateId, employee_id: seed.employees.anna.id, slot_at: NOW, issued_at: '2026-09-07T12:00:00.000Z', due_at: NOW, status: 'pending' })
    expect(listInstances(db, { to: '2026-09-07T12:00:00.000Z' })).toHaveLength(1)
    expect(listInstances(db, { from: '2026-09-07T10:00:00.000Z', to: '2026-09-07T12:00:00.001Z' })).toHaveLength(2)
  })
})

describe('submissions', () => {
  let instanceId: number
  beforeEach(() => {
    const t = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null)
    instanceId = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'submitted' })!.id
  })

  it('creates with photos, tracks ai lifecycle and owner decision', () => {
    const s = createSubmission(db, instanceId, NOW, [{ path: 'a.jpg', fileUniqueId: 'u1' }, { path: 'b.jpg', fileUniqueId: 'u2' }])
    expect(s).toMatchObject({ ai_status: 'pending', ai_attempts: 0, decision: null, ai_issues: [] })
    expect(photoExists(db, 'u1')).toBe(true)
    expect(photoExists(db, 'zz')).toBe(false)
    markAiStarted(db, s.id)
    saveAiResult(db, s.id, { score: 55, verdict: 'Грязный поддон', issues: ['поддон'] }, 'needs_review', NOW)
    expect(getSubmission(db, s.id)).toMatchObject({ ai_status: 'done', ai_attempts: 1, ai_score: 55, ai_issues: ['поддон'], decision: 'needs_review' })
    const queue = listReviewQueue(db)
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ title: 'Помыть кофемашину', employee_name: 'Иван Петров' })
    expect(queue[0]!.photos).toHaveLength(2)
    expect(setOwnerDecision(db, s.id, 'owner_rejected', 'Переделать', NOW)).toBe(true)
    expect(setOwnerDecision(db, s.id, 'owner_accepted', null, NOW)).toBe(false)
    expect(listReviewQueue(db)).toEqual([])
  })

  it('ai writes lose to an already made decision', () => {
    const s = createSubmission(db, instanceId, NOW, [{ path: 'a.jpg', fileUniqueId: 'u1' }])
    expect(saveAiResult(db, s.id, { score: 91, verdict: 'ok', issues: [] }, 'auto_accepted', NOW)).toBe(true)
    // решение уже есть: повторный результат ИИ и отметка о сбое не должны его перезаписывать
    expect(saveAiResult(db, s.id, { score: 10, verdict: 'плохо', issues: ['x'] }, 'needs_review', NOW)).toBe(false)
    expect(markAiFailed(db, s.id, NOW)).toBe(false)
    expect(getSubmission(db, s.id)).toMatchObject({ ai_status: 'done', ai_score: 91, decision: 'auto_accepted' })
  })

  it('failed ai goes to review; stale pending is listed', () => {
    const s = createSubmission(db, instanceId, '2026-09-07T09:50:00.000Z', [{ path: 'a.jpg', fileUniqueId: 'u1' }])
    expect(listStaleAiPending(db, '2026-09-07T09:57:00.000Z').map((x) => x.id)).toEqual([s.id])
    expect(markAiFailed(db, s.id, NOW)).toBe(true)
    expect(getSubmission(db, s.id)).toMatchObject({ ai_status: 'failed', decision: 'needs_review' })
    expect(listStaleAiPending(db, NOW)).toEqual([])
  })

  it('photo retention helpers', () => {
    const s = createSubmission(db, instanceId, '2026-06-01T00:00:00.000Z', [{ path: 'old.jpg', fileUniqueId: 'u1' }])
    const old = listPhotosOlderThan(db, '2026-07-01T00:00:00.000Z')
    expect(old.map((p) => p.path)).toEqual(['old.jpg'])
    markPhotoDeleted(db, old[0]!.id, NOW)
    expect(listPhotosOlderThan(db, '2026-07-01T00:00:00.000Z')).toEqual([])
    expect(getSubmission(db, s.id)).not.toBeNull()
  })
})

describe('bot states', () => {
  it('round-trips json and clears', () => {
    expect(getState(db, 500)).toBeNull()
    setState(db, 500, { kind: 'collecting_photos', instance_id: 1, photos: [] })
    expect(getState<{ kind: string }>(db, 500)?.kind).toBe('collecting_photos')
    setState(db, 500, { kind: 'x' })
    expect(getState<{ kind: string }>(db, 500)?.kind).toBe('x')
    clearState(db, 500)
    expect(getState(db, 500)).toBeNull()
  })
})
