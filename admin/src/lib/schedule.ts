import type { InstanceStatus, Schedule } from '../api'

export const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

function daysText(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.length === 7) return 'Ежедневно'
  if (sorted.join() === '1,2,3,4,5') return 'По будням'
  return sorted.map((d) => DAY_LABELS[d - 1]).join(', ')
}

export function describeSchedule(s: Schedule | null): string {
  if (!s) return 'Разовое'
  if (s.kind === 'weekly') return `${daysText(s.days)} в ${[...s.times].sort().join(', ')}`
  const h = s.every_minutes % 60 === 0 ? `${s.every_minutes / 60} ч` : `${s.every_minutes} мин`
  return `${daysText(s.days)} каждые ${h} с ${s.from} до ${s.to}`
}

export const STATUS_LABEL: Record<InstanceStatus, string> = {
  open: 'Никто не взял',
  pending: 'Выполняется',
  submitted: 'Проверяет ИИ',
  review: 'На проверке',
  accepted: 'Принято',
  overdue: 'Просрочено',
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
