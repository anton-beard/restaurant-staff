import type { Db } from './connect.js'
import type { Employee } from './employees.js'
import type { Schedule } from '../tasks/schedule.js'

export type AssigneeMode = 'by_position' | 'by_employees'
export type Distribution = 'each' | 'shared'

export type TaskTemplate = {
  id: number
  title: string
  description: string
  requires_photo: boolean
  photo_criteria: string | null
  auto_accept_threshold: number
  assignee_mode: AssigneeMode
  distribution: Distribution
  schedule: Schedule | null
  deadline_minutes: number
  next_run_at: string | null
  active: boolean
  created_at: string
  position_ids: number[]
  employee_ids: number[]
}

export type TaskTemplateInput = Omit<TaskTemplate, 'id' | 'next_run_at' | 'active' | 'created_at'>

type Row = {
  id: number; title: string; description: string; requires_photo: number; photo_criteria: string | null
  auto_accept_threshold: number; assignee_mode: AssigneeMode; distribution: Distribution
  schedule_kind: 'once' | 'weekly' | 'interval'; schedule: string | null; deadline_minutes: number
  next_run_at: string | null; active: number; created_at: string
}

const columns =
  'id, title, description, requires_photo, photo_criteria, auto_accept_threshold, assignee_mode, distribution, schedule_kind, schedule, deadline_minutes, next_run_at, active, created_at'

function hydrate(db: Db, row: Row): TaskTemplate {
  const position_ids = (db.prepare('select position_id from task_template_positions where template_id = ? order by position_id').all(row.id) as { position_id: number }[]).map((r) => r.position_id)
  const employee_ids = (db.prepare('select employee_id from task_template_employees where template_id = ? order by employee_id').all(row.id) as { employee_id: number }[]).map((r) => r.employee_id)
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    requires_photo: row.requires_photo === 1,
    photo_criteria: row.photo_criteria,
    auto_accept_threshold: row.auto_accept_threshold,
    assignee_mode: row.assignee_mode,
    distribution: row.distribution,
    schedule: row.schedule ? (JSON.parse(row.schedule) as Schedule) : null,
    deadline_minutes: row.deadline_minutes,
    next_run_at: row.next_run_at,
    active: row.active === 1,
    created_at: row.created_at,
    position_ids,
    employee_ids,
  }
}

function writeLinks(db: Db, id: number, input: TaskTemplateInput): void {
  db.prepare('delete from task_template_positions where template_id = ?').run(id)
  db.prepare('delete from task_template_employees where template_id = ?').run(id)
  const ip = db.prepare('insert into task_template_positions (template_id, position_id) values (?, ?)')
  const ie = db.prepare('insert into task_template_employees (template_id, employee_id) values (?, ?)')
  if (input.assignee_mode === 'by_position') for (const p of input.position_ids) ip.run(id, p)
  else for (const e of input.employee_ids) ie.run(id, e)
}

export function getTaskTemplate(db: Db, id: number): TaskTemplate | null {
  const row = db.prepare(`select ${columns} from task_templates where id = ?`).get(id) as Row | undefined
  return row ? hydrate(db, row) : null
}

export function createTaskTemplate(db: Db, input: TaskTemplateInput, nextRunAt: string | null): TaskTemplate {
  return db.transaction(() => {
    const info = db
      .prepare(
        `insert into task_templates (title, description, requires_photo, photo_criteria, auto_accept_threshold, assignee_mode, distribution, schedule_kind, schedule, deadline_minutes, next_run_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.title, input.description, input.requires_photo ? 1 : 0, input.requires_photo ? input.photo_criteria : null,
        input.auto_accept_threshold, input.assignee_mode, input.distribution, input.schedule?.kind ?? 'once',
        input.schedule ? JSON.stringify(input.schedule) : null, input.deadline_minutes, nextRunAt,
      )
    const id = Number(info.lastInsertRowid)
    writeLinks(db, id, input)
    return getTaskTemplate(db, id)!
  })()
}

export function updateTaskTemplate(db: Db, id: number, input: TaskTemplateInput, nextRunAt: string | null): TaskTemplate | null {
  return db.transaction(() => {
    const info = db
      .prepare(
        `update task_templates set title = ?, description = ?, requires_photo = ?, photo_criteria = ?, auto_accept_threshold = ?, assignee_mode = ?, distribution = ?, schedule_kind = ?, schedule = ?, deadline_minutes = ?, next_run_at = ? where id = ?`,
      )
      .run(
        input.title, input.description, input.requires_photo ? 1 : 0, input.requires_photo ? input.photo_criteria : null,
        input.auto_accept_threshold, input.assignee_mode, input.distribution, input.schedule?.kind ?? 'once',
        input.schedule ? JSON.stringify(input.schedule) : null, input.deadline_minutes, nextRunAt, id,
      )
    if (info.changes === 0) return null
    writeLinks(db, id, input)
    return getTaskTemplate(db, id)
  })()
}

export function listTaskTemplates(db: Db, opts: { includeInactive?: boolean } = {}): TaskTemplate[] {
  const where = opts.includeInactive ? '' : 'where active = 1'
  const rows = db.prepare(`select ${columns} from task_templates ${where} order by active desc, title`).all() as Row[]
  return rows.map((r) => hydrate(db, r))
}

export function setTemplateActive(db: Db, id: number, active: boolean, nextRunAt: string | null): TaskTemplate | null {
  const info = db.prepare('update task_templates set active = ?, next_run_at = ? where id = ?').run(active ? 1 : 0, nextRunAt, id)
  return info.changes === 0 ? null : getTaskTemplate(db, id)
}

export function setNextRunAt(db: Db, id: number, iso: string | null): void {
  db.prepare('update task_templates set next_run_at = ? where id = ?').run(iso, id)
}

export function listDueTemplates(db: Db, nowIso: string): TaskTemplate[] {
  const rows = db
    .prepare(`select ${columns} from task_templates where active = 1 and schedule is not null and next_run_at is not null and next_run_at <= ? order by next_run_at`)
    .all(nowIso) as Row[]
  return rows.map((r) => hydrate(db, r))
}

const employeeColumns = 'e.id, e.full_name, e.phone, e.position_id, e.telegram_id, e.status, e.created_at'

export function eligibleEmployees(db: Db, template: TaskTemplate): Employee[] {
  if (template.assignee_mode === 'by_position') {
    return db
      .prepare(
        `select ${employeeColumns} from employees e join task_template_positions tp on tp.position_id = e.position_id
         where tp.template_id = ? and e.status = 'active' order by e.full_name`,
      )
      .all(template.id) as Employee[]
  }
  return db
    .prepare(
      `select ${employeeColumns} from employees e join task_template_employees te on te.employee_id = e.id
       where te.template_id = ? and e.status = 'active' order by e.full_name`,
    )
    .all(template.id) as Employee[]
}
