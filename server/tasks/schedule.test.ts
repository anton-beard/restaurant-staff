import { describe, expect, it } from 'vitest'
import { nextRun, scheduleSchema, slotsForDay, type Schedule } from './schedule.js'

const MSK = 'Europe/Moscow'
const weekly: Schedule = { kind: 'weekly', days: [1, 3], times: ['22:00', '10:00'] }
const interval: Schedule = { kind: 'interval', days: [1, 2, 3, 4, 5, 6, 7], from: '10:00', to: '23:00', every_minutes: 120 }

describe('scheduleSchema', () => {
  it('accepts valid schedules and rejects bad ones', () => {
    expect(scheduleSchema.safeParse(weekly).success).toBe(true)
    expect(scheduleSchema.safeParse(interval).success).toBe(true)
    expect(scheduleSchema.safeParse({ kind: 'weekly', days: [], times: ['10:00'] }).success).toBe(false)
    expect(scheduleSchema.safeParse({ kind: 'weekly', days: [1], times: ['25:00'] }).success).toBe(false)
    expect(scheduleSchema.safeParse({ ...interval, from: '23:00', to: '10:00' }).success).toBe(false)
    expect(scheduleSchema.safeParse({ ...interval, every_minutes: 5 }).success).toBe(false)
  })
})

describe('slotsForDay', () => {
  it('sorts weekly times and skips other days', () => {
    expect(slotsForDay(weekly, 1)).toEqual(['10:00', '22:00'])
    expect(slotsForDay(weekly, 2)).toEqual([])
  })
  it('expands intervals inclusively up to "to"', () => {
    expect(slotsForDay(interval, 5)).toEqual(['10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'])
    expect(slotsForDay({ ...interval, to: '22:00' }, 5)).toHaveLength(7)
  })
})

describe('nextRun', () => {
  it('finds the next slot the same day, strictly after', () => {
    // Monday 10:30 MSK -> Monday 22:00 MSK
    expect(nextRun(weekly, new Date('2026-09-07T07:30:00Z'), MSK).toISOString()).toBe('2026-09-07T19:00:00.000Z')
    // exactly at 22:00 MSK -> Wednesday 10:00 MSK
    expect(nextRun(weekly, new Date('2026-09-07T19:00:00Z'), MSK).toISOString()).toBe('2026-09-09T07:00:00.000Z')
  })
  it('wraps to the next week', () => {
    // Wednesday 23:00 MSK -> next Monday 10:00 MSK
    expect(nextRun(weekly, new Date('2026-09-09T20:00:00Z'), MSK).toISOString()).toBe('2026-09-14T07:00:00.000Z')
  })
  it('handles intervals across the day boundary', () => {
    expect(nextRun(interval, new Date('2026-09-07T18:30:00Z'), MSK).toISOString()).toBe('2026-09-07T19:00:00.000Z')
    expect(nextRun(interval, new Date('2026-09-07T19:00:00Z'), MSK).toISOString()).toBe('2026-09-08T07:00:00.000Z')
  })
  it('respects the zone', () => {
    const s: Schedule = { kind: 'weekly', days: [1], times: ['09:00'] }
    expect(nextRun(s, new Date('2026-09-07T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-09-07T13:00:00.000Z')
  })
})
