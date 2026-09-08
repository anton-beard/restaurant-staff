import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

export type ReviewInput = {
  photos: { data: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }[]
  title: string
  description: string
  criteria: string
}
export type ReviewResult = { score: number; verdict: string; issues: string[] }
export type Reviewer = (input: ReviewInput) => Promise<ReviewResult>

export const reviewSchema = z.object({
  score: z.number().int().min(0).max(100),
  verdict: z.string().max(300),
  issues: z.array(z.string().max(200)).max(10),
})

export const SYSTEM_PROMPT = `Ты проверяющий в ресторане. Сотрудник выполнил задание и прислал фото-отчёт.
Оцени по фото, насколько выполнены критерии задания, по шкале от 0 до 100:
100 — все критерии выполнены и это видно на фото; около 80 — есть мелкие замечания;
ниже 50 — существенные нарушения или по фото нельзя судить о ключевых критериях.
Если какой-то критерий не виден ни на одном фото, снижай балл и назови это в issues.
Не додумывай то, чего нет на снимках. Отвечай по-русски, коротко: verdict одной-двумя фразами,
issues — список конкретных замечаний (пустой, если всё в порядке).`

export function buildMessages(input: ReviewInput): Anthropic.MessageParam[] {
  const images: Anthropic.ImageBlockParam[] = input.photos.map((p) => ({
    type: 'image',
    source: { type: 'base64', media_type: p.mediaType, data: p.data.toString('base64') },
  }))
  const text: Anthropic.TextBlockParam = {
    type: 'text',
    text: [
      `Задание: ${input.title}`,
      input.description ? `Описание: ${input.description}` : '',
      `Критерии для фото: ${input.criteria}`,
      `Фото в отчёте: ${input.photos.length}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  }
  return [{ role: 'user', content: [...images, text] }]
}

export async function reviewPhotos(input: ReviewInput, deps: { client: Anthropic; model: string }): Promise<ReviewResult> {
  const response = await deps.client.messages.parse(
    {
      model: deps.model,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: zodOutputFormat(reviewSchema) },
      // Промпт ~150 токенов, ниже минимума кэширования (1024+); cache_control включать только если он вырастет
      system: SYSTEM_PROMPT,
      messages: buildMessages(input),
    },
    { timeout: 60_000 },
  )
  if (!response.parsed_output) {
    throw new Error(
      `claude returned no structured output (stop_reason=${response.stop_reason}${response.stop_details ? ', ' + JSON.stringify(response.stop_details) : ''})`,
    )
  }
  return response.parsed_output
}

export function createReviewer(apiKey: string, model: string): Reviewer {
  const client = new Anthropic({ apiKey })
  return (input) => reviewPhotos(input, { client, model })
}
