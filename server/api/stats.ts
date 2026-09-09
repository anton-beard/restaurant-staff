import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import { getDigestTime, setSetting, WEEKLY_DIGEST_TIME } from '../db/settings.js'
import { idParams, parse } from '../lib/validate.js'
import { employeeCard } from '../stats/employeeCard.js'
import { periodDaysBack, rating } from '../stats/metrics.js'
import { summary } from '../stats/summary.js'

type Opts = { db: Db; tz: string; now?: () => Date }

const daysQuery = z.object({ days: z.enum(['7', '30', '90']).default('30') })
const digestBody = z.object({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ') })

export const statsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db, tz } = opts
  const now = opts.now ?? (() => new Date())

  app.get('/api/stats/summary', async () => summary(db, now(), tz))

  app.get('/api/stats/rating', async (req) => {
    const { days } = parse(daysQuery, req.query)
    return rating(db, periodDaysBack(now(), Number(days)))
  })

  app.get('/api/stats/employees/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const { days } = parse(daysQuery, req.query)
    return employeeCard(db, id, periodDaysBack(now(), Number(days))) ?? reply.code(404).send({ error: 'not_found' })
  })

  app.get('/api/settings/digest', async () => ({ time: getDigestTime(db) }))

  app.put('/api/settings/digest', async (req) => {
    const { time } = parse(digestBody, req.body)
    setSetting(db, WEEKLY_DIGEST_TIME, time)
    return { time }
  })
}
