import type { Db } from './connect.js'

export type InstanceStatus = 'open' | 'pending' | 'submitted' | 'review' | 'accepted' | 'overdue'

export type TaskInstance = {
  id: number
  template_id: number
  employee_id: number | null
  slot_at: string
  issued_at: string
  due_at: string
  claimed_at: string | null
  status: InstanceStatus
  completed_at: string | null
  reminder_sent_at: string | null
}

export type InstanceRow = TaskInstance & {
  title: string
  requires_photo: boolean
  employee_name: string | null
  last_score: number | null
}

const cols = 'i.id, i.template_id, i.employee_id, i.slot_at, i.issued_at, i.due_at, i.claimed_at, i.status, i.completed_at, i.reminder_sent_at'
const rowSelect = `select ${cols}, t.title, t.requires_photo, e.full_name as employee_name,
  (select s.ai_score from task_submissions s where s.instance_id = i.id order by s.id desc limit 1) as last_score
  from task_instances i join task_templates t on t.id = i.template_id left join employees e on e.id = i.employee_id`

type RawRow = Omit<InstanceRow, 'requires_photo'> & { requires_photo: number }
const toRow = (r: RawRow): InstanceRow => ({ ...r, requires_photo: r.requires_photo === 1 })

export function createInstance(
  db: Db,
  input: { template_id: number; employee_id: number | null; slot_at: string; issued_at: string; due_at: string; status: 'open' | 'pending' },
): TaskInstance | null {
  try {
    const info = db
      .prepare('insert into task_instances (template_id, employee_id, slot_at, issued_at, due_at, status) values (?, ?, ?, ?, ?, ?)')
      .run(input.template_id, input.employee_id, input.slot_at, input.issued_at, input.due_at, input.status)
    return getInstance(db, Number(info.lastInsertRowid))
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null
    throw err
  }
}

export function getInstance(db: Db, id: number): TaskInstance | null {
  return (db.prepare(`select ${cols} from task_instances i where i.id = ?`).get(id) as TaskInstance) ?? null
}

export function getInstanceRow(db: Db, id: number): InstanceRow | null {
  const r = db.prepare(`${rowSelect} where i.id = ?`).get(id) as RawRow | undefined
  return r ? toRow(r) : null
}

export function listEmployeeInstances(db: Db, employeeId: number, statuses: InstanceStatus[]): InstanceRow[] {
  const marks = statuses.map(() => '?').join(', ')
  const rows = db.prepare(`${rowSelect} where i.employee_id = ? and i.status in (${marks}) order by i.due_at`).all(employeeId, ...statuses) as RawRow[]
  return rows.map(toRow)
}

export function listInstances(
  db: Db,
  f: { status?: InstanceStatus; employee_id?: number; template_id?: number; from?: string; to?: string },
): InstanceRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.status) { where.push('i.status = ?'); args.push(f.status) }
  if (f.employee_id) { where.push('i.employee_id = ?'); args.push(f.employee_id) }
  if (f.template_id) { where.push('i.template_id = ?'); args.push(f.template_id) }
  if (f.from) { where.push('i.issued_at >= ?'); args.push(f.from) }
  if (f.to) { where.push('i.issued_at < ?'); args.push(f.to) }
  const sql = `${rowSelect} ${where.length ? 'where ' + where.join(' and ') : ''} order by i.issued_at desc, i.id desc limit 500`
  return (db.prepare(sql).all(...args) as RawRow[]).map(toRow)
}

export function setInstanceStatus(db: Db, id: number, status: InstanceStatus, extra: { completed_at?: string | null } = {}): void {
  if ('completed_at' in extra) {
    db.prepare('update task_instances set status = ?, completed_at = ? where id = ?').run(status, extra.completed_at ?? null, id)
  } else {
    db.prepare('update task_instances set status = ? where id = ?').run(status, id)
  }
}

export function claimInstance(db: Db, id: number, employeeId: number, nowIso: string): boolean {
  const info = db
    .prepare("update task_instances set employee_id = ?, claimed_at = ?, status = 'pending' where id = ? and status = 'open'")
    .run(employeeId, nowIso, id)
  return info.changes === 1
}

export function addOffer(db: Db, instanceId: number, telegramId: number, messageId: number): void {
  db.prepare('insert into task_offers (instance_id, telegram_id, message_id) values (?, ?, ?)').run(instanceId, telegramId, messageId)
}

export function listOffers(db: Db, instanceId: number): { telegram_id: number; message_id: number }[] {
  return db.prepare('select telegram_id, message_id from task_offers where instance_id = ? order by id').all(instanceId) as { telegram_id: number; message_id: number }[]
}

export function listReminderCandidates(db: Db, nowIso: string): TaskInstance[] {
  return db
    .prepare(`select ${cols} from task_instances i where i.status = 'pending' and i.reminder_sent_at is null and i.due_at > ? order by i.due_at`)
    .all(nowIso) as TaskInstance[]
}

export function markReminderSent(db: Db, id: number, nowIso: string): void {
  db.prepare('update task_instances set reminder_sent_at = ? where id = ?').run(nowIso, id)
}

export function listOverdueCandidates(db: Db, nowIso: string): TaskInstance[] {
  return db
    .prepare(`select ${cols} from task_instances i where i.status in ('open', 'pending') and i.due_at < ? order by i.due_at`)
    .all(nowIso) as TaskInstance[]
}

export function countOverdueSince(db: Db, sinceIso: string): number {
  return (db.prepare("select count(*) c from task_instances where status = 'overdue' and due_at >= ?").get(sinceIso) as { c: number }).c
}
