<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type Course, type Position } from '../api'

const courses = ref<Course[]>([])
const positions = ref<Position[]>([])
const error = ref('')
const info = ref('')
const publishing = ref<Course | null>(null)
const STATUS: Record<Course['status'], string> = { draft: 'Черновик', published: 'Опубликован', archived: 'В архиве' }

async function load() {
  try {
    ;[courses.value, positions.value] = await Promise.all([api.learning.courses.list(true), api.positions.list()])
  } catch (err) {
    error.value = errorText(err)
  }
}
const positionNames = (ids: number[]) => ids.map((id) => positions.value.find((p) => p.id === id)?.name ?? '?').join(', ')

function publish(c: Course) {
  info.value = ''
  error.value = ''
  publishing.value = c
}

async function doPublish(assignExisting: boolean) {
  if (!publishing.value) return
  error.value = ''
  try {
    const r = await api.learning.courses.publish(publishing.value.id, assignExisting)
    info.value = `Опубликовано. Назначено сотрудникам: ${r.assigned}`
    publishing.value = null
    await load()
  } catch (err) {
    error.value = errorText(err)
  }
}

async function archive(c: Course) {
  if (!window.confirm(`Отправить курс «${c.title}» в архив? Начатые назначения останутся.`)) return
  error.value = ''
  try {
    await api.learning.courses.archive(c.id)
    await load()
  } catch (err) {
    error.value = errorText(err)
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-4">
      <h1 class="text-xl font-semibold">Курсы</h1>
      <RouterLink to="/learning/courses/new" class="btn ml-auto">Новый курс</RouterLink>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <p v-if="info" class="text-sm text-green-700">{{ info }}</p>
    <div v-if="publishing" class="bg-white rounded-xl shadow p-4 space-y-3 text-sm">
      <p>Публикация курса «{{ publishing.title }}». Кому назначить?</p>
      <div class="flex flex-wrap gap-2">
        <button class="btn" @click="doPublish(true)">Всем текущим сотрудникам должностей</button>
        <button class="btn-secondary" @click="doPublish(false)">Только новым сотрудникам</button>
        <button class="btn-secondary" @click="publishing = null">Отмена</button>
      </div>
    </div>
    <table class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500">
        <tr><th class="px-4 py-2">Название</th><th class="px-4 py-2">Должности</th><th class="px-4 py-2">Уроков</th><th class="px-4 py-2">Срок, дней</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody class="divide-y">
        <tr v-for="c in courses" :key="c.id" :class="{ 'text-gray-400': c.status === 'archived' }">
          <td class="px-4 py-2">{{ c.title }}</td>
          <td class="px-4 py-2">{{ positionNames(c.position_ids) || '—' }}</td>
          <td class="px-4 py-2">{{ c.lesson_count }}</td>
          <td class="px-4 py-2">{{ c.due_days }}</td>
          <td class="px-4 py-2">{{ STATUS[c.status] }}</td>
          <td class="px-4 py-2 text-right space-x-2 whitespace-nowrap">
            <RouterLink :to="`/learning/courses/${c.id}/edit`" class="btn-secondary">Изменить</RouterLink>
            <button v-if="c.status !== 'published'" class="btn-secondary" @click="publish(c)">Опубликовать</button>
            <button v-if="c.status !== 'archived'" class="btn-secondary" @click="archive(c)">В архив</button>
          </td>
        </tr>
        <tr v-if="courses.length === 0"><td colspan="6" class="px-4 py-3 text-gray-500">Пока пусто</td></tr>
      </tbody>
    </table>
  </div>
</template>
