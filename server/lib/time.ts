export type LocalParts = { y: number; m: number; d: number; hh: number; mm: number; weekday: number }

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    formatters.set(tz, f)
  }
  return f
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {}
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour) % 24,
    mm: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday!] ?? 1,
  }
}

/**
 * Момент UTC для локального времени в зоне tz.
 * Если такого локального времени нет (весенний перевод часов), берём более поздний
 * из двух кандидатов, то есть сдвигаем вперёд: 02:30 в «дыре» становится 03:30.
 * Если локальное время существует дважды (осенний перевод), возвращается более ранний момент.
 */
export function zonedToUtc(p: { y: number; m: number; d: number; hh: number; mm: number }, tz: string): Date {
  const target = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm)
  let guess = target
  let previous = Number.NaN
  for (let i = 0; i < 4; i++) {
    const lp = localParts(new Date(guess), tz)
    const offset = Date.UTC(lp.y, lp.m - 1, lp.d, lp.hh, lp.mm) - guess
    const next = target - offset
    if (next === guess) return new Date(guess)
    if (next === previous) return new Date(Math.max(guess, next)) // осцилляция: локального времени не существует
    previous = guess
    guess = next
  }
  return new Date(guess)
}

export function addDays(p: { y: number; m: number; d: number }, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

const two = (n: number) => String(n).padStart(2, '0')

export function formatLocal(date: Date, tz: string, now: Date): string {
  const p = localParts(date, tz)
  const n = localParts(now, tz)
  const time = `${two(p.hh)}:${two(p.mm)}`
  if (p.y === n.y && p.m === n.m && p.d === n.d) return time
  return `${two(p.d)}.${two(p.m)} ${time}`
}

export function localMidnight(now: Date, tz: string): Date {
  const p = localParts(now, tz)
  return zonedToUtc({ y: p.y, m: p.m, d: p.d, hh: 0, mm: 0 }, tz)
}

export function ymdLocal(date: Date, tz: string): string {
  const p = localParts(date, tz)
  return `${p.y}-${two(p.m)}-${two(p.d)}`
}
