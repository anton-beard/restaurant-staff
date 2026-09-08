import { z } from 'zod'
import { addDays, localParts, zonedToUtc } from '../lib/time.js'

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ')
const days = z.array(z.number().int().min(1).max(7)).min(1, 'Выберите хотя бы один день')

export const scheduleSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('weekly'), days, times: z.array(time).min(1, 'Добавьте хотя бы одно время') }),
    z.object({
      kind: z.literal('interval'),
      days,
      from: time,
      to: time,
      every_minutes: z.number().int().min(15, 'Не чаще чем раз в 15 минут'),
    }),
  ])
  .refine((s) => s.kind === 'weekly' || toMinutes(s.from) < toMinutes(s.to), {
    message: 'Время «с» должно быть раньше времени «до»',
  })

export type Schedule = z.infer<typeof scheduleSchema>

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

const fromMinutes = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`

export function slotsForDay(schedule: Schedule, weekday: number): string[] {
  if (!schedule.days.includes(weekday)) return []
  if (schedule.kind === 'weekly') return [...new Set(schedule.times)].sort()
  const out: string[] = []
  for (let t = toMinutes(schedule.from); t <= toMinutes(schedule.to); t += schedule.every_minutes) {
    out.push(fromMinutes(t))
  }
  return out
}

export function nextRun(schedule: Schedule, after: Date, tz: string): Date {
  const start = localParts(after, tz)
  for (let offset = 0; offset <= 7; offset++) {
    const day = addDays(start, offset)
    const weekday = ((start.weekday - 1 + offset) % 7) + 1
    for (const slot of slotsForDay(schedule, weekday)) {
      const [hh, mm] = slot.split(':').map(Number)
      const t = zonedToUtc({ ...day, hh: hh!, mm: mm! }, tz)
      if (t.getTime() > after.getTime()) return t
    }
  }
  throw new Error('schedule has no upcoming slot')
}
