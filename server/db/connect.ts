import Database from 'better-sqlite3'
import { migrations } from './migrations.js'

export type Db = Database.Database

export function openDb(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  const applied = new Set(
    db
      .prepare('select name from schema_migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  )
  const mark = db.prepare('insert into schema_migrations (name) values (?)')
  for (const m of migrations) {
    if (applied.has(m.name)) continue
    db.transaction(() => {
      db.exec(m.sql)
      mark.run(m.name)
    })()
  }
  return db
}
