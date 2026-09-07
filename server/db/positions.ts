import type { Db } from './connect.js'

export type Position = { id: number; name: string }

export function listPositions(db: Db): Position[] {
  return db.prepare('select id, name from positions order by name').all() as Position[]
}

export function createPosition(db: Db, name: string): Position {
  const info = db.prepare('insert into positions (name) values (?)').run(name)
  return { id: Number(info.lastInsertRowid), name }
}

export function renamePosition(db: Db, id: number, name: string): Position | null {
  const info = db.prepare('update positions set name = ? where id = ?').run(name, id)
  return info.changes === 0 ? null : { id, name }
}

export function deletePosition(db: Db, id: number): 'deleted' | 'in_use' | 'not_found' {
  const inUse = db
    .prepare('select 1 from employees where position_id = ? limit 1')
    .get(id)
  if (inUse) return 'in_use'
  const info = db.prepare('delete from positions where id = ?').run(id)
  return info.changes === 0 ? 'not_found' : 'deleted'
}
