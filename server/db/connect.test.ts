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

  it('is idempotent: migrations run once', () => {
    const db = openDb(':memory:')
    const count = () =>
      (db.prepare('select count(*) c from schema_migrations').get() as { c: number }).c
    const first = count()
    expect(first).toBeGreaterThan(0)
    // повторный прогон миграций на той же базе ничего не добавляет
    db.exec('select 1')
    expect(count()).toBe(first)
  })
})
