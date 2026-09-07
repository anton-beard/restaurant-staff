import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import { createPosition, deletePosition, listPositions, renamePosition } from '../db/positions.js'
import { idParams, parse } from '../lib/validate.js'

const body = z.object({ name: z.string().trim().min(1).max(100) })

export const positionRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/api/positions', async () => listPositions(db))

  app.post('/api/positions', async (req, reply) => {
    const { name } = parse(body, req.body)
    return reply.code(201).send(createPosition(db, name))
  })

  app.patch('/api/positions/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const { name } = parse(body, req.body)
    const updated = renamePosition(db, id, name)
    return updated ?? reply.code(404).send({ error: 'not_found' })
  })

  app.delete('/api/positions/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const result = deletePosition(db, id)
    if (result === 'in_use') return reply.code(409).send({ error: 'in_use' })
    if (result === 'not_found') return reply.code(404).send({ error: 'not_found' })
    return reply.code(204).send()
  })
}
