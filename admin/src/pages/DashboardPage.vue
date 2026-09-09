<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api, errorText, type RatingDays, type RatingRow, type Summary } from '../api'

const summary = ref<Summary | null>(null)
const rows = ref<RatingRow[]>([])
const days = ref<RatingDays>(30)
const digestTime = ref('09:00')
const error = ref('')
const info = ref('')

async function loadSummary() {
  try {
    summary.value = await api.stats.summary()
    digestTime.value = (await api.settings.digest()).time
  } catch (err) {
    error.value = errorText(err)
  }
}
async function loadRating() {
  try {
    rows.value = await api.stats.rating(days.value)
  } catch (err) {
    error.value = errorText(err)
  }
}
async function saveDigest() {
  error.value = ''
  info.value = ''
  try {
    await api.settings.setDigest(digestTime.value)
    info.value = `Недельная сводка будет приходить по понедельникам в ${digestTime.value}.`
  } catch (err) {
    error.value = errorText(err, { validation: 'Время в формате ЧЧ:ММ.' })
  }
}
const pct = (share: number | null) => (share === null ? '—' : `${Math.round(share * 100)}%`)

onMounted(() => {
  void loadSummary()
  void loadRating()
})
watch(days, loadRating)
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-xl font-semibold">Сводка</h1>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <div v-if="summary" class="grid gap-4 md:grid-cols-4 text-sm">
      <div class="bg-white rounded-xl shadow p-4">
        <div class="text-gray-500">Сегодня</div>
        <div class="text-2xl font-semibold">{{ summary.today.onTime }} <span class="text-base font-normal text-gray-500">в срок из {{ summary.today.issued }} выданных</span></div>
        <div :class="summary.today.overdue ? 'text-red-700' : 'text-gray-500'">Просрочено: {{ summary.today.overdue }}, поздно: {{ summary.today.late }}</div>
      </div>
      <div class="bg-white rounded-xl shadow p-4">
        <div class="text-gray-500">7 дней</div>
        <div class="text-2xl font-semibold">{{ summary.week.onTime }} <span class="text-base font-normal text-gray-500">в срок из {{ summary.week.issued }}</span></div>
        <div :class="summary.week.overdue ? 'text-red-700' : 'text-gray-500'">Просрочено: {{ summary.week.overdue }}, поздно: {{ summary.week.late }}</div>
      </div>
      <RouterLink to="/review" class="bg-white rounded-xl shadow p-4 hover:bg-gray-50">
        <div class="text-gray-500">Ждёт проверки</div>
        <div class="text-2xl font-semibold">{{ summary.queue.awaitingOwner }}</div>
        <div class="text-gray-500">Проверяет ИИ: {{ summary.queue.awaitingAi }}</div>
      </RouterLink>
      <div class="bg-white rounded-xl shadow p-4">
        <div class="text-gray-500">Обучение</div>
        <div>Курсов в процессе: {{ summary.learning.coursesInProgress }}</div>
        <div :class="summary.learning.coursesOverdue ? 'text-red-700' : ''">Курсов просрочено: {{ summary.learning.coursesOverdue }}</div>
        <div>Тестов за 7 дней: сдано {{ summary.week.quizzesPassed }}, провалено {{ summary.week.quizzesFailed }}</div>
      </div>
    </div>

    <section class="space-y-3">
      <div class="flex items-center gap-3">
        <h2 class="font-semibold">Рейтинг сотрудников</h2>
        <div class="flex gap-1">
          <button v-for="d in [7, 30, 90] as RatingDays[]" :key="d" class="btn-secondary" :class="{ 'bg-gray-900 text-white': days === d }" @click="days = d">{{ d }} дней</button>
        </div>
      </div>
      <table class="w-full bg-white rounded-xl shadow text-sm">
        <thead class="text-left text-gray-500">
          <tr><th class="px-4 py-2">#</th><th class="px-4 py-2">Сотрудник</th><th class="px-4 py-2">Должность</th><th class="px-4 py-2">Балл</th><th class="px-4 py-2">В срок</th><th class="px-4 py-2">Тесты</th><th class="px-4 py-2">Просрочек</th></tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="r in rows" :key="r.employee_id" :class="{ 'text-red-700': r.tasks.overdue > 0 }">
            <td class="px-4 py-2">{{ r.place ?? '—' }}</td>
            <td class="px-4 py-2"><RouterLink :to="`/employees/${r.employee_id}`" class="underline">{{ r.full_name }}</RouterLink></td>
            <td class="px-4 py-2">{{ r.position_name }}</td>
            <td class="px-4 py-2 font-semibold">{{ r.score ?? 'нет данных' }}</td>
            <td class="px-4 py-2">{{ r.tasks.total ? `${r.tasks.onTime} из ${r.tasks.total} (${pct(r.tasks.onTimeShare)})` : '—' }}</td>
            <td class="px-4 py-2">{{ r.quiz.avgScore ?? '—' }}</td>
            <td class="px-4 py-2">{{ r.tasks.overdue }}</td>
          </tr>
          <tr v-if="rows.length === 0"><td colspan="7" class="px-4 py-3 text-gray-500">Нет активных сотрудников</td></tr>
        </tbody>
      </table>
    </section>

    <section class="bg-white rounded-xl shadow p-4 text-sm space-y-2 max-w-md">
      <div class="font-medium">Недельная сводка в боте</div>
      <form class="flex gap-2 items-center" @submit.prevent="saveDigest">
        <span>По понедельникам в</span>
        <input v-model="digestTime" type="time" class="input max-w-32" required />
        <button class="btn">Сохранить</button>
      </form>
      <p v-if="info" class="text-green-700">{{ info }}</p>
    </section>
  </div>
</template>
