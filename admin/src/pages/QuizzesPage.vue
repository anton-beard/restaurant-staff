<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type Position, type Quiz } from '../api'
import { describeSchedule } from '../lib/schedule'

const quizzes = ref<Quiz[]>([])
const positions = ref<Position[]>([])
const error = ref('')
const STATUS: Record<Quiz['status'], string> = { draft: 'Черновик', published: 'Опубликован', archived: 'В архиве' }

async function load() {
  try {
    ;[quizzes.value, positions.value] = await Promise.all([api.learning.quizzes.list(true), api.positions.list()])
  } catch (err) {
    error.value = errorText(err)
  }
}
const positionNames = (ids: number[]) => ids.map((id) => positions.value.find((p) => p.id === id)?.name ?? '?').join(', ')
async function run(fn: () => Promise<unknown>) {
  error.value = ''
  try {
    await fn()
    await load()
  } catch (err) {
    error.value = errorText(err, { not_published: 'Сначала опубликуйте тест.' })
  }
}
const publish = (q: Quiz) => run(() => api.learning.quizzes.publish(q.id))
const issue = (q: Quiz) => run(async () => { const r = await api.learning.quizzes.issue(q.id); window.alert(`Выдано сотрудникам: ${r.assigned}`) })
const archive = (q: Quiz) => { if (window.confirm(`Отправить тест «${q.title}» в архив?`)) void run(() => api.learning.quizzes.archive(q.id)) }
onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-4">
      <h1 class="text-xl font-semibold">Тесты</h1>
      <RouterLink to="/learning/quizzes/new" class="btn ml-auto">Новый тест</RouterLink>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <div class="table-wrap"><table class="w-full text-sm">
      <thead class="text-left text-gray-500">
        <tr><th class="px-4 py-2">Название</th><th class="hidden md:table-cell px-4 py-2">Должности</th><th class="px-4 py-2">Расписание</th><th class="hidden md:table-cell px-4 py-2">Вопросов</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody class="divide-y">
        <tr v-for="q in quizzes" :key="q.id" :class="{ 'text-gray-400': q.status === 'archived' }">
          <td class="px-4 py-2">{{ q.title }}</td>
          <td class="hidden md:table-cell px-4 py-2">{{ positionNames(q.position_ids) || '—' }}</td>
          <td class="px-4 py-2">{{ q.schedule ? describeSchedule(q.schedule) : 'Без расписания' }}</td>
          <td class="hidden md:table-cell px-4 py-2">{{ q.question_count }}</td>
          <td class="px-4 py-2">{{ STATUS[q.status] }}</td>
          <td class="px-4 py-2 text-right"><div class="flex flex-col sm:flex-row sm:justify-end gap-1 sm:gap-2">
            <RouterLink :to="`/learning/quizzes/${q.id}/edit`" class="btn-secondary">Изменить</RouterLink>
            <button v-if="q.status !== 'published'" class="btn-secondary" @click="publish(q)">Опубликовать</button>
            <button v-if="q.status === 'published'" class="btn-secondary" @click="issue(q)">Выдать сейчас</button>
            <button v-if="q.status !== 'archived'" class="btn-secondary" @click="archive(q)">В архив</button>
          </div></td>
        </tr>
        <tr v-if="quizzes.length === 0"><td colspan="6" class="px-4 py-3 text-gray-500">Пока пусто</td></tr>
      </tbody>
    </table></div>
  </div>
</template>
