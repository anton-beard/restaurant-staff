import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import {
  createTaskTemplate, getTaskTemplate, listTaskTemplates, setTemplateActive, updateTaskTemplate, type TaskTemplateInput,
} from '../db/taskTemplates.js'
import { getInstanceRow, listInstances } from '../db/taskInstances.js'
import { listSubmissionsForInstance } from '../db/taskSubmissions.js'
import { idParams, parse } from '../lib/validate.js'
import type { Notifier } from '../notify.js'
import { issueTemplate } from '../tasks/issue.js'
import { nextRun, scheduleSchema } from '../tasks/schedule.js'

type Opts = { db: Db; notifier: Notifier; tz: string; now?: () => Date }

const templateBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).default(''),
    requires_photo: z.boolean(),
    photo_criteria: z.string().trim().max(2000).nullable().default(null),
    auto_accept_threshold: z.number().int().min(0).max(100).default(80),
    assignee_mode: z.enum(['by_position', 'by_employees']),
    distribution: z.enum(['each', 'shared']),
    position_ids: z.array(z.number().int().positive()).default([]),
    employee_ids: z.array(z.number().int().positive()).default([]),
    schedule: scheduleSchema.nullable(),
    deadline_minutes: z.number().int().min(5),
  })
  .superRefine((b, ctx) => {
    if (b.requires_photo && !b.photo_criteria) {
      ctx.addIssue({ code: 'custom', path: ['photo_criteria'], message: 'Опишите критерии для фото' })
    }
    if (b.assignee_mode === 'by_position' && b.position_ids.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['position_ids'], message: 'Выберите хотя бы одну должность' })
    }
    if (b.assignee_mode === 'by_employees' && b.employee_ids.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['employee_ids'], message: 'Выберите хотя бы одного сотрудника' })
    }
  })

const listQuery = z.object({ includeInactive: z.string().optional() })
const instancesQuery = z.object({
  status: z.enum(['open', 'pending', 'submitted', 'review', 'accepted', 'overdue']).optional(),
  employee_id: z.coerce.number().int().positive().optional(),
  template_id: z.coerce.number().int().positive().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

export const taskRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db, notifier, tz } = opts
  const now = opts.now ?? (() => new Date())
  const toInput = (b: z.infer<typeof templateBody>): TaskTemplateInput => ({ ...b, photo_criteria: b.requires_photo ? b.photo_criteria : null })
  const nextRunFor = (input: TaskTemplateInput): string | null => (input.schedule ? nextRun(input.schedule, now(), tz).toISOString() : null)

  app.get('/api/tasks/templates', async (req) => {
    const q = parse(listQuery, req.query)
    return listTaskTemplates(db, { includeInactive: q.includeInactive === '1' })
  })

  app.post('/api/tasks/templates', async (req, reply) => {
    const input = toInput(parse(templateBody, req.body))
    const template = createTaskTemplate(db, input, nextRunFor(input))
    let issued: { created: number; notified: number } | null = null
    if (!input.schedule) {
      const t = now()
      const r = await issueTemplate({ db, notifier, tz }, template, t, t)
      issued = { created: r.created.length, notified: r.notified }
    }
    return reply.code(201).send({ template, issued })
  })

  app.get('/api/tasks/templates/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    return getTaskTemplate(db, id) ?? reply.code(404).send({ error: 'not_found' })
  })

  app.patch('/api/tasks/templates/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const input = toInput(parse(templateBody, req.body))
    const current = getTaskTemplate(db, id)
    if (!current) return reply.code(404).send({ error: 'not_found' })
    const updated = updateTaskTemplate(db, id, input, current.active ? nextRunFor(input) : null)
    return updated ?? reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/tasks/templates/:id/deactivate', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    return setTemplateActive(db, id, false, null) ?? reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/tasks/templates/:id/activate', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const t = getTaskTemplate(db, id)
    if (!t) return reply.code(404).send({ error: 'not_found' })
    return setTemplateActive(db, id, true, t.schedule ? nextRun(t.schedule, now(), tz).toISOString() : null)
  })

  app.get('/api/tasks/instances', async (req) => listInstances(db, parse(instancesQuery, req.query)))

  app.get('/api/tasks/instances/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const instance = getInstanceRow(db, id)
    if (!instance) return reply.code(404).send({ error: 'not_found' })
    return { instance, submissions: listSubmissionsForInstance(db, id) }
  })
}
