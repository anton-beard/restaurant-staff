import { describe, expect, it } from 'vitest'
import { addDays, formatLocal, localParts, zonedToUtc } from './time.js'

const MSK = 'Europe/Moscow'

describe('time', () => {
  it('localParts converts to the zone and numbers weekdays Mon=1', () => {
    // 2026-09-07 is a Monday; 19:00Z = 22:00 MSK
    const p = localParts(new Date('2026-09-07T19:00:00Z'), MSK)
    expect(p).toEqual({ y: 2026, m: 9, d: 7, hh: 22, mm: 0, weekday: 1 })
    // 22:30Z Monday = 01:30 Tuesday MSK
    expect(localParts(new Date('2026-09-07T22:30:00Z'), MSK)).toMatchObject({ d: 8, hh: 1, mm: 30, weekday: 2 })
    expect(localParts(new Date('2026-09-13T12:00:00Z'), MSK).weekday).toBe(7)
  })

  it('zonedToUtc inverts localParts, including a DST zone', () => {
    expect(zonedToUtc({ y: 2026, m: 9, d: 7, hh: 22, mm: 0 }, MSK).toISOString()).toBe('2026-09-07T19:00:00.000Z')
    expect(zonedToUtc({ y: 2026, m: 9, d: 7, hh: 9, mm: 0 }, 'America/New_York').toISOString()).toBe('2026-09-07T13:00:00.000Z')
    expect(zonedToUtc({ y: 2026, m: 1, d: 5, hh: 9, mm: 0 }, 'America/New_York').toISOString()).toBe('2026-01-05T14:00:00.000Z')
    // 2026-11-01 03:00 New York is after the fall-back: EST, UTC-5
    expect(zonedToUtc({ y: 2026, m: 11, d: 1, hh: 3, mm: 0 }, 'America/New_York').toISOString()).toBe('2026-11-01T08:00:00.000Z')
    // the day before is still EDT, UTC-4
    expect(zonedToUtc({ y: 2026, m: 10, d: 31, hh: 3, mm: 0 }, 'America/New_York').toISOString()).toBe('2026-10-31T07:00:00.000Z')
  })

  it('addDays crosses month boundaries', () => {
    expect(addDays({ y: 2026, m: 9, d: 30 }, 1)).toEqual({ y: 2026, m: 10, d: 1 })
    expect(addDays({ y: 2026, m: 1, d: 1 }, -1)).toEqual({ y: 2025, m: 12, d: 31 })
  })

  it('formatLocal shows time only on the same local day', () => {
    const now = new Date('2026-09-07T08:00:00Z')
    expect(formatLocal(new Date('2026-09-07T19:00:00Z'), MSK, now)).toBe('22:00')
    expect(formatLocal(new Date('2026-09-08T06:05:00Z'), MSK, now)).toBe('08.09 09:05')
  })
})
