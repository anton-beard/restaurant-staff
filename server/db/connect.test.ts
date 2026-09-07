import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from './connect.js'

describe('openDb', () => {
  it('creates stage 1 tables', () => {
    const db = openDb(':memory:')
    const names = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(names).toEqual(
      expect.arrayContaining([
        'positions',
        'employees',
        'bot_states',
        'owner_login_codes',
        'owner_sessions',
        'settings',
        'schema_migrations',
      ]),
    )
  })

  it('enforces foreign keys and unique phone', () => {
    const db = openDb(':memory:')
    expect(() =>
      db
        .prepare(
          "insert into employees (full_name, phone, position_id) values ('A', '+79990000001', 999)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)
    db.prepare("insert into positions (name) values ('Официант')").run()
    const ins = db.prepare(
      "insert into employees (full_name, phone, position_id) values (?, ?, 1)",
    )
    ins.run('A', '+79990000001')
    expect(() => ins.run('B', '+79990000001')).toThrow(/UNIQUE/)
  })

  it('is idempotent: reopening the same file does not re-run migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-'))
    const file = join(dir, 'app.db')
    try {
      const first = openDb(file)
      const count = (db: ReturnType<typeof openDb>) =>
        (db.prepare('select count(*) c from schema_migrations').get() as { c: number }).c
      const applied = count(first)
      expect(applied).toBeGreaterThan(0)
      first.prepare("insert into positions (name) values ('Официант')").run()
      first.close()

      const second = openDb(file)
      expect(count(second)).toBe(applied)
      expect(second.prepare('select count(*) c from positions').get()).toEqual({ c: 1 })
      expect(second.pragma('journal_mode', { simple: true })).toBe('wal')
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
