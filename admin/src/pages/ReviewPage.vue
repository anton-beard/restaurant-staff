<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type ReviewRow } from '../api'
import { fmtDate } from '../lib/schedule'
import { refreshReviewCount } from '../reviewCount'

const queue = ref<ReviewRow[]>([])
const error = ref('')
const comments = ref<Record<number, string>>({})
const big = ref<Record<number, number>>({})

async function load() {
  try {
    queue.value = await api.tasks.reviewQueue()
    await refreshReviewCount()
  } catch (err) {
    error.value = errorText(err)
  }
}

async function decide(row: ReviewRow, decision: 'accept' | 'reject') {
  error.value = ''
  const comment = comments.value[row.id]?.trim()
  if (decision === 'reject' && !comment) {
    error.value = 'Для отклонения напишите комментарий сотруднику.'
    return
  }
  try {
    await api.tasks.decide(row.id, decision, comment || undefined)
    await load()
  } catch (err) {
    error.value = errorText(err, { already_decided: 'Уже решено (возможно, из бота).' })
    await load()
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Проверка фото</h1>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <p v-if="queue.length === 0" class="text-sm text-gray-500">Очередь пуста</p>

    <section v-for="row in queue" :key="row.id" class="bg-white rounded-xl shadow p-4 grid gap-4 md:grid-cols-2">
      <div class="space-y-2">
        <img :src="`/api/uploads/${row.photos[big[row.id] ?? 0]?.path}`" class="w-full rounded-lg object-contain max-h-96 bg-gray-100" />
        <div class="flex gap-2">
          <img v-for="(p, i) in row.photos" :key="p.id" :src="`/api/uploads/${p.path}`" class="h-16 rounded cursor-pointer border-2"
            :class="(big[row.id] ?? 0) === i ? 'border-gray-900' : 'border-transparent'" @click="big[row.id] = i" />
        </div>
      </div>
      <div class="space-y-3 text-sm">
        <div class="font-semibold text-base">{{ row.title }}</div>
        <div>{{ row.employee_name }} · {{ fmtDate(row.created_at) }}</div>
        <div v-if="row.photo_criteria" class="text-gray-600">Критерии: {{ row.photo_criteria }}</div>
        <div v-if="row.ai_status === 'done'" class="rounded-lg bg-gray-50 p-3">
          <div>Оценка ИИ: <b>{{ row.ai_score }}</b> из 100</div>
          <div>{{ row.ai_verdict }}</div>
          <ul v-if="row.ai_issues.length" class="list-disc pl-5"><li v-for="(i, k) in row.ai_issues" :key="k">{{ i }}</li></ul>
        </div>
        <div v-else class="rounded-lg bg-amber-50 text-amber-800 p-3">ИИ недоступен, проверьте вручную.</div>
        <textarea v-model="comments[row.id]" class="input" rows="2" placeholder="Комментарий сотруднику (обязателен при отклонении)" />
        <div class="flex gap-2">
          <button class="btn" @click="decide(row, 'accept')">Принять</button>
          <button class="btn-secondary" @click="decide(row, 'reject')">Отклонить</button>
        </div>
      </div>
    </section>
  </div>
</template>
