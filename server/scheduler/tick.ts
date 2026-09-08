import type { Db } from '../db/connect.js'
import type { Notifier } from '../notify.js'
import type { ReviewQueue } from '../tasks/reviewQueue.js'
import { cleanup } from './cleanup.js'
import { issueDueTemplates } from './issueDue.js'
import { markOverdue } from './overdue.js'
import { sendReminders } from './reminders.js'
import { retryStaleReviews } from './retryReviews.js'

export type SchedulerDeps = {
  db: Db
  notifier: Notifier
  tz: string
  uploadsDir: string
  reviewQueue: Pick<ReviewQueue, 'enqueue' | 'isActive'>
  now?: () => Date
}
export type Scheduler = { tick(): Promise<void>; start(intervalMs?: number): () => void }

export const CLEANUP_INTERVAL_MS = 60 * 60_000

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date())
  let running = false
  let lastCleanup = 0

  async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      console.error(`scheduler step ${name} failed`, err)
    }
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const t = now()
      await step('issue', () => issueDueTemplates(deps, t))
      await step('reminders', () => sendReminders(deps, t))
      await step('overdue', () => markOverdue(deps, t))
      await step('retryReviews', () => retryStaleReviews(deps, t))
      if (t.getTime() - lastCleanup >= CLEANUP_INTERVAL_MS) {
        lastCleanup = t.getTime()
        await step('cleanup', () => cleanup(deps, t))
      }
    } finally {
      running = false
    }
  }

  return {
    tick,
    start(intervalMs = 60_000) {
      const first = setTimeout(() => void tick(), 5_000)
      const timer = setInterval(() => void tick(), intervalMs)
      return () => {
        clearTimeout(first)
        clearInterval(timer)
      }
    },
  }
}
