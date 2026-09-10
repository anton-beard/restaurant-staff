<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText, type CourseBody, type Lesson, type Position, type Question } from '../api'
import QuestionsEditor from '../components/QuestionsEditor.vue'

const props = defineProps<{ id?: string }>()
const router = useRouter()
const editing = computed(() => props.id !== undefined)
const positions = ref<Position[]>([])
const error = ref('')
const busy = ref(false)
type FormLesson = Lesson & { key: number }
const form = reactive<Omit<CourseBody, 'lessons'> & { lessons: FormLesson[] }>({ title: '', description: '', due_days: 7, pass_score: 80, position_ids: [], lessons: [], questions: [] })
const videoDraft = ref<Record<number, string>>({})
let nextKey = 0

async function load() {
  positions.value = await api.positions.list()
  if (!props.id) return
  const d = await api.learning.courses.get(Number(props.id))
  Object.assign(form, {
    title: d.course.title, description: d.course.description, due_days: d.course.due_days, pass_score: d.course.pass_score,
    position_ids: d.course.position_ids, lessons: d.lessons.map((l) => ({ title: l.title, body: l.body, media: [...l.media], key: nextKey++ })), questions: d.questions.map((q) => ({ text: q.text, options: [...q.options], correct_index: q.correct_index })),
  })
}

const addLesson = () => form.lessons.push({ title: '', body: '', media: [], key: nextKey++ })
const removeLesson = (i: number) => form.lessons.splice(i, 1)
function move(i: number, d: -1 | 1) {
  const j = i + d
  if (j < 0 || j >= form.lessons.length) return
  const [l] = form.lessons.splice(i, 1)
  form.lessons.splice(j, 0, l as FormLesson)
}
async function addImage(i: number, ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  error.value = ''
  try {
    const { path } = await api.learning.upload(file)
    form.lessons[i]!.media.push({ kind: 'image', path })
  } catch (err) {
    error.value = errorText(err, { validation: 'Картинка jpg, png или webp до 5 МБ.' })
  } finally {
    input.value = ''
  }
}
function addVideo(l: FormLesson) {
  const url = (videoDraft.value[l.key] ?? '').trim()
  if (!url) return
  l.media.push({ kind: 'video', url })
  videoDraft.value[l.key] = ''
}
const removeMedia = (i: number, j: number) => form.lessons[i]!.media.splice(j, 1)
const setQuestions = (q: Question[]) => (form.questions = q)

async function save() {
  busy.value = true
  error.value = ''
  try {
    const body: CourseBody = { ...form, due_days: Number(form.due_days), pass_score: Number(form.pass_score), lessons: form.lessons.map(({ key, ...rest }) => rest) }
    if (editing.value) await api.learning.courses.update(Number(props.id), body)
    else await api.learning.courses.create(body)
    await router.push('/learning/courses')
  } catch (err) {
    error.value = errorText(err, { invalid_reference: 'Выбранная должность не существует.' })
  } finally {
    busy.value = false
  }
}

onMounted(() => load().catch((err) => (error.value = errorText(err))))
</script>

<template>
  <form class="space-y-5 max-w-3xl" @submit.prevent="save">
    <h1 class="text-xl font-semibold">{{ editing ? 'Курс' : 'Новый курс' }}</h1>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <label class="block text-sm">Название<input v-model="form.title" class="input mt-1" required maxlength="200" /></label>
      <label class="block text-sm">Описание<textarea v-model="form.description" class="input mt-1" rows="2" /></label>
      <div class="flex flex-wrap gap-3 text-sm">
        <label v-for="p in positions" :key="p.id" class="flex items-center gap-1"><input v-model="form.position_ids" type="checkbox" :value="p.id" /> {{ p.name }}</label>
      </div>
      <div class="flex flex-wrap gap-4 text-sm">
        <label>Срок, дней<input v-model.number="form.due_days" type="number" min="1" max="365" class="input mt-1 max-w-32" required /></label>
        <label>Проходной балл<input v-model.number="form.pass_score" type="number" min="0" max="100" class="input mt-1 max-w-32" required /></label>
      </div>
    </section>

    <section class="bg-white rounded-xl shadow p-4 space-y-4">
      <div class="text-sm font-medium">Уроки</div>
      <div v-for="(l, i) in form.lessons" :key="l.key" class="border rounded-lg p-3 space-y-2">
        <div class="flex flex-wrap gap-2 items-center">
          <span class="text-sm text-gray-500 w-6">{{ i + 1 }}.</span>
          <input v-model="l.title" class="input flex-1 min-w-48" placeholder="Заголовок урока" required />
          <div class="flex gap-2 ml-auto">
            <button type="button" class="btn-secondary" @click="move(i, -1)">↑</button>
            <button type="button" class="btn-secondary" @click="move(i, 1)">↓</button>
            <button type="button" class="btn-secondary" @click="removeLesson(i)">Убрать</button>
          </div>
        </div>
        <textarea v-model="l.body" class="input" rows="4" placeholder="Текст урока" />
        <div class="flex flex-wrap gap-2 items-center text-sm">
          <template v-for="(m, j) in l.media" :key="j">
            <span class="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1">
              <img v-if="m.kind === 'image'" :src="`/api/uploads/${m.path}`" alt="картинка урока" class="h-8 rounded" />
              <span v-else class="truncate max-w-48">{{ m.url }}</span>
              <button type="button" class="text-gray-500" @click="removeMedia(i, j)">×</button>
            </span>
          </template>
        </div>
        <div class="flex flex-wrap gap-2 items-center text-sm">
          <label class="btn-secondary cursor-pointer">Добавить картинку<input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" @change="addImage(i, $event)" /></label>
          <input v-model="videoDraft[l.key]" class="input sm:max-w-72" placeholder="Ссылка на видео (YouTube и т.п.)" />
          <button type="button" class="btn-secondary" @click="addVideo(l)">Добавить видео</button>
        </div>
      </div>
      <button type="button" class="btn-secondary" @click="addLesson">+ урок</button>
    </section>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="text-sm font-medium">Итоговый тест</div>
      <QuestionsEditor :model-value="form.questions" @update:model-value="setQuestions" />
    </section>

    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <div class="flex gap-2">
      <button class="btn" :disabled="busy">Сохранить</button>
      <RouterLink to="/learning/courses" class="btn-secondary">Отмена</RouterLink>
    </div>
  </form>
</template>
