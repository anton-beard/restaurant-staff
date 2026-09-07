import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import {
  archiveEmployee,
  createEmployee,
  listEmployees,
  updateEmployee,
} from '../db/employees.js'
import { normalizePhone } from '../lib/phone.js'
import { parse, ValidationError } from '../lib/validate.js'

const phone = z.string().transform((raw, ctx) => {
  const normalized = normalizePhone(raw)
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: 'Некорректный номер телефона' })
    return z.NEVER
  }
  return normalized
})

const createBody = z.object({
  full_name: z.string().trim().min(1).max(200),
  phone,
  position_id: z.number().int().positive(),
})
const patchBody = createBody.partial()
const params = z.object({ id: z.coerce.number().int().positive() })
const listQuery = z.object({ includeArchived: z.string().optional() })

export const employeeRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/api/employees', async (req) => {
    const q = parse(listQuery, req.query)
    return listEmployees(db, { includeArchived: q.includeArchived === '1' })
  })

  app.post('/api/employees', async (req, reply) => {
    const input = parse(createBody, req.body)
    return reply.code(201).send(createEmployee(db, input))
  })

  app.patch('/api/employees/:id', async (req, reply) => {
    const { id } = parse(params, req.params)
    const patch = parse(patchBody, req.body)
    if (Object.keys(patch).length === 0) throw new ValidationError([{ message: 'Пустое изменение' }])
    const updated = updateEmployee(db, id, patch)
    return updated ?? reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/employees/:id/archive', async (req, reply) => {
    const { id } = parse(params, req.params)
    const archived = archiveEmployee(db, id)
    return archived ?? reply.code(404).send({ error: 'not_found' })
  })
}
