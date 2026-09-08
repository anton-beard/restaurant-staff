import { describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { buildMessages, reviewPhotos, SYSTEM_PROMPT, type ReviewInput } from './photoReview.js'

const input: ReviewInput = {
  photos: [
    { data: Buffer.from('a'), mediaType: 'image/jpeg' },
    { data: Buffer.from('b'), mediaType: 'image/jpeg' },
    { data: Buffer.from('c'), mediaType: 'image/png' },
  ],
  title: 'Помыть кофемашину',
  description: 'Группы и поддон',
  criteria: 'Группы чистые, поддон пустой',
}

function fakeClient(parsed: unknown) {
  const parse = vi.fn(async () => ({ parsed_output: parsed }))
  return { client: { messages: { parse } } as unknown as Anthropic, parse }
}

describe('buildMessages', () => {
  it('sends every photo as an image block followed by the task text', () => {
    const [msg] = buildMessages(input)
    const content = msg!.content as Anthropic.ContentBlockParam[]
    expect(content).toHaveLength(4)
    expect(content.slice(0, 3).every((b) => b.type === 'image')).toBe(true)
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('a').toString('base64') } })
    expect(content[3]).toMatchObject({ type: 'text' })
    const text = (content[3] as { text: string }).text
    expect(text).toContain('Помыть кофемашину')
    expect(text).toContain('Группы чистые, поддон пустой')
  })
})

describe('reviewPhotos', () => {
  it('passes model, cached system prompt and structured output, returns parsed result', async () => {
    const { client, parse } = fakeClient({ score: 87, verdict: 'Чисто', issues: [] })
    const result = await reviewPhotos(input, { client, model: 'claude-sonnet-5' })
    expect(result).toEqual({ score: 87, verdict: 'Чисто', issues: [] })
    const params = parse.mock.calls[0]![0] as Record<string, unknown>
    expect(params.model).toBe('claude-sonnet-5')
    expect(JSON.stringify(params.system)).toContain(SYSTEM_PROMPT.slice(0, 40))
    expect(JSON.stringify(params.system)).toContain('ephemeral')
    expect(params.output_config).toMatchObject({ effort: 'low' })
    expect((params.output_config as { format?: unknown }).format).toBeDefined()
  })

  it('throws when the model returned nothing parseable', async () => {
    const { client } = fakeClient(null)
    await expect(reviewPhotos(input, { client, model: 'm' })).rejects.toThrow(/structured/)
  })
})
