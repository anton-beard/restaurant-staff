import type { Db } from '../db/connect.js'
import { createEmployee, linkTelegram, type Employee } from '../db/employees.js'
import { createPosition, type Position } from '../db/positions.js'

export function seedRestaurant(db: Db) {
  const cook = createPosition(db, 'Повар')
  const admin = createPosition(db, 'Администратор')
  const barista = createPosition(db, 'Бариста')
  const ivan = createEmployee(db, { full_name: 'Иван Петров', phone: '+79990000001', position_id: barista.id })
  const anna = createEmployee(db, { full_name: 'Анна Смирнова', phone: '+79990000002', position_id: barista.id })
  const petr = createEmployee(db, { full_name: 'Пётр Кузнецов', phone: '+79990000003', position_id: cook.id })
  const olga = createEmployee(db, { full_name: 'Ольга Новикова', phone: '+79990000004', position_id: admin.id })
  linkTelegram(db, ivan.id, 500)
  linkTelegram(db, anna.id, 501)
  linkTelegram(db, petr.id, 502)
  const positions: Record<'cook' | 'admin' | 'barista', Position> = { cook, admin, barista }
  const employees: Record<'ivan' | 'anna' | 'petr' | 'olga', Employee> = {
    ivan: { ...ivan, telegram_id: 500, status: 'active' },
    anna: { ...anna, telegram_id: 501, status: 'active' },
    petr: { ...petr, telegram_id: 502, status: 'active' },
    olga,
  }
  return { positions, employees }
}
