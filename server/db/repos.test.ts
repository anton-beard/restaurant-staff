import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './connect.js'
import { createPosition, deletePosition, listPositions, renamePosition } from './positions.js'
import {
  archiveEmployee,
  createEmployee,
  findEmployeeByPhone,
  findEmployeeByTelegramId,
  getEmployee,
  linkTelegram,
  listEmployees,
  updateEmployee,
} from './employees.js'
import { getSetting, OWNER_TELEGRAM_ID, setSetting } from './settings.js'

let db: Db
beforeEach(() => {
  db = openDb(':memory:')
})

describe('positions', () => {
  it('creates, lists, renames', () => {
    const p = createPosition(db, 'Официант')
    expect(p).toEqual({ id: 1, name: 'Официант' })
    expect(listPositions(db)).toEqual([p])
    expect(renamePosition(db, 1, 'Бармен')).toEqual({ id: 1, name: 'Бармен' })
    expect(renamePosition(db, 42, 'X')).toBeNull()
  })

  it('refuses to delete a position in use', () => {
    const p = createPosition(db, 'Повар')
    createEmployee(db, { full_name: 'А', phone: '+79990000001', position_id: p.id })
    expect(deletePosition(db, p.id)).toBe('in_use')
    expect(deletePosition(db, 99)).toBe('not_found')
    const free = createPosition(db, 'Хостес')
    expect(deletePosition(db, free.id)).toBe('deleted')
  })
})

describe('employees', () => {
  it('creates and reads', () => {
    const p = createPosition(db, 'Официант')
    const e = createEmployee(db, { full_name: 'Иван', phone: '+79990000001', position_id: p.id })
    expect(e).toMatchObject({ id: 1, full_name: 'Иван', status: 'invited', telegram_id: null })
    expect(getEmployee(db, 1)).toEqual(e)
    expect(findEmployeeByPhone(db, '+79990000001')).toEqual(e)
    expect(findEmployeeByPhone(db, '+70000000000')).toBeNull()
  })

  it('updates, links telegram, archives', () => {
    const p = createPosition(db, 'Официант')
    createEmployee(db, { full_name: 'Иван', phone: '+79990000001', position_id: p.id })
    expect(updateEmployee(db, 1, { full_name: 'Пётр' })?.full_name).toBe('Пётр')
    const linked = linkTelegram(db, 1, 123456789)
    expect(linked).toMatchObject({ status: 'active', telegram_id: 123456789 })
    expect(findEmployeeByTelegramId(db, 123456789)?.id).toBe(1)
    expect(archiveEmployee(db, 1)?.status).toBe('archived')
    expect(listEmployees(db)).toEqual([])
    expect(listEmployees(db, { includeArchived: true })).toHaveLength(1)
    expect(updateEmployee(db, 77, { full_name: 'X' })).toBeNull()
  })
})

describe('settings', () => {
  it('sets and gets', () => {
    expect(getSetting(db, OWNER_TELEGRAM_ID)).toBeNull()
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    setSetting(db, OWNER_TELEGRAM_ID, '43')
    expect(getSetting(db, OWNER_TELEGRAM_ID)).toBe('43')
  })
})
