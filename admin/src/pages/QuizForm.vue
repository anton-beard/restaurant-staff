<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText, type Position, type Question, type QuizBody } from '../api'
import QuestionsEditor from '../components/QuestionsEditor.vue'
import { DAY_LABELS } from '../lib/schedule'

const props = defineProps<{ id?: string }>()
const router = useRouter()
const editing = computed(() => props.id !== undefined)
const positions = ref<Position[]>([])
const error = ref('')
const busy = ref(false)
const form = reactive({
  title: '', pass_score: 80, position_ids: [] as number[], scheduled: false, days: [1] as number[], times: ['10:00'] as string[],
  deadline_minutes: 480, questions: [] as Question[],
})

async function load() {
  positions.value = await api.positions.list()
  if (!props.id) return
  const d = await api.learning.quizzes.get(Number(props.id))
  Object.assign(form, {
    title: d.quiz.title, pass_score: d.quiz.pass_score, position_ids: d.quiz.position_ids, scheduled: d.quiz.schedule !== null,
    deadline_minutes: d.quiz.deadline_minutes ?? 480, questions: d.questions.map((q) => ({ text: q.text, options: [...q.options], correct_index: q.correct_index })),
  })
  if (d.quiz.schedule?.kind === 'weekly') { form.days = d.quiz.schedule.days; form.times = d.quiz.schedule.times }
}
const toggleDay = (d: number) => (form.days = form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d])
const setQuestions = (q: Question[]) => (form.questions = q)

async function save() {
  busy.value = true
  error.value = ''
  try {
    const body: QuizBody = {
      title: form.title, pass_score: Number(form.pass_score), position_ids: form.position_ids,
      schedule: form.scheduled ? { kind: 'weekly', days: form.days, times: form.times.filter(Boolean) } : null,
      deadline_minutes: Number(form.deadline_minutes), questions: form.questions,
    }
    if (editing.value) await api.learning.quizzes.update(Number(props.id), body)
    else await api.learning.quizzes.create(body)
    await router.push('/learning/quizzes')
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}
onMounted(() => load().catch((err) => (error.value = errorText(err))))
</script>

<template>
  <form class="space-y-5 max-w-3xl" @submit.prevent="save">
    <h1 class="text-xl font-semibold">{{ editing ? 'Тест' : 'Новый тест' }}</h1>
    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <label class="block text-sm">Название<input v-model="form.title" class="input mt-1" required maxlength="200" /></label>
      <div class="flex flex-wrap gap-3 text-sm">
        <label v-for="p in positions" :key="p.id" class="flex items-center gap-1"><input v-model="form.position_ids" type="checkbox" :value="p.id" /> {{ p.name }}</label>
      </div>
      <div class="flex gap-4 text-sm">
        <label>Проходной балл<input v-model.number="form.pass_score" type="number" min="0" max="100" class="input mt-1 max-w-32" required /></label>
        <label>Срок на прохождение, минут<input v-model.number="form.deadline_minutes" type="number" min="15" class="input mt-1 max-w-32" required /></label>
      </div>
      <label class="flex items-center gap-2 text-sm"><input v-model="form.scheduled" type="checkbox" /> Выдавать по расписанию</label>
      <template v-if="form.scheduled">
        <div class="flex gap-1">
          <button v-for="(label, i) in DAY_LABELS" :key="i" type="button" class="btn-secondary" :class="{ 'bg-gray-900 text-white': form.days.includes(i + 1) }" @click="toggleDay(i + 1)">{{ label }}</button>
        </div>
        <div class="space-y-2">
          <div v-for="(_, i) in form.times" :key="i" class="flex gap-2 items-center">
            <input v-model="form.times[i]" type="time" class="input max-w-40" required />
            <button v-if="form.times.length > 1" type="button" class="btn-secondary" @click="form.times.splice(i, 1)">Убрать</button>
          </div>
          <button type="button" class="btn-secondary" @click="form.times.push('12:00')">+ время</button>
        </div>
      </template>
    </section>
    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="text-sm font-medium">Вопросы</div>
      <QuestionsEditor :model-value="form.questions" @update:model-value="setQuestions" />
    </section>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <div class="flex gap-2">
      <button class="btn" :disabled="busy">Сохранить</button>
      <RouterLink to="/learning/quizzes" class="btn-secondary">Отмена</RouterLink>
    </div>
  </form>
</template>
