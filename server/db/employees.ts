import type { Db } from './connect.js'

export type EmployeeStatus = 'invited' | 'active' | 'archived'

export type Employee = {
  id: number
  full_name: string
  phone: string
  position_id: number
  telegram_id: number | null
  status: EmployeeStatus
  created_at: string
}

const columns = 'id, full_name, phone, position_id, telegram_id, status, created_at'

export function listEmployees(db: Db, opts: { includeArchived?: boolean } = {}): Employee[] {
  const where = opts.includeArchived ? '' : "where status != 'archived'"
  return db
    .prepare(`select ${columns} from employees ${where} order by full_name`)
    .all() as Employee[]
}

export function getEmployee(db: Db, id: number): Employee | null {
  return (db.prepare(`select ${columns} from employees where id = ?`).get(id) as Employee) ?? null
}

export function createEmployee(
  db: Db,
  input: { full_name: string; phone: string; position_id: number },
): Employee {
  const info = db
    .prepare('insert into employees (full_name, phone, position_id) values (?, ?, ?)')
    .run(input.full_name, input.phone, input.position_id)
  return getEmployee(db, Number(info.lastInsertRowid))!
}

export function updateEmployee(
  db: Db,
  id: number,
  patch: Partial<{ full_name: string; phone: string; position_id: number }>,
): Employee | null {
  const current = getEmployee(db, id)
  if (!current) return null
  const next = { ...current, ...patch }
  db.prepare('update employees set full_name = ?, phone = ?, position_id = ? where id = ?').run(
    next.full_name,
    next.phone,
    next.position_id,
    id,
  )
  return getEmployee(db, id)
}

export function archiveEmployee(db: Db, id: number): Employee | null {
  const info = db.prepare("update employees set status = 'archived' where id = ?").run(id)
  return info.changes === 0 ? null : getEmployee(db, id)
}

export function findEmployeeByPhone(db: Db, phone: string): Employee | null {
  return (
    (db.prepare(`select ${columns} from employees where phone = ?`).get(phone) as Employee) ?? null
  )
}

export function findEmployeeByTelegramId(db: Db, telegramId: number): Employee | null {
  return (
    (db
      .prepare(`select ${columns} from employees where telegram_id = ?`)
      .get(telegramId) as Employee) ?? null
  )
}

export function linkTelegram(db: Db, id: number, telegramId: number): Employee | null {
  const info = db
    .prepare("update employees set telegram_id = ?, status = 'active' where id = ?")
    .run(telegramId, id)
  return info.changes === 0 ? null : getEmployee(db, id)
}
