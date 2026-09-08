<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type TaskTemplate } from '../api'
import { describeSchedule } from '../lib/schedule'

const templates = ref<TaskTemplate[]>([])
const error = ref('')
const showArchived = ref(false)

async function load() {
  try {
    templates.value = await api.tasks.templates.list(showArchived.value)
  } catch (err) {
    error.value = errorText(err)
  }
}

async function toggle(t: TaskTemplate) {
  error.value = ''
  try {
    if (t.active) await api.tasks.templates.deactivate(t.id)
    else await api.tasks.templates.activate(t.id)
    await load()
  } catch (err) {
    error.value = errorText(err)
  }
}

async function remove(t: TaskTemplate) {
  if (!window.confirm(`Удалить задание «${t.title}»?`)) return
  error.value = ''
  try {
    await api.tasks.templates.remove(t.id)
    await load()
  } catch (err) {
    error.value = errorText(err, { has_instances: 'По заданию уже есть история, отправьте его в архив.' })
  }
}

const assignees = (t: TaskTemplate) =>
  t.assignee_mode === 'by_position' ? `Должности: ${t.position_ids.length}` : `Сотрудники: ${t.employee_ids.length}`

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-4">
      <h1 class="text-xl font-semibold">Задания</h1>
      <RouterLink to="/tasks/new" class="btn ml-auto">Новое задание</RouterLink>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <label class="flex items-center gap-2 text-sm text-gray-600">
      <input type="checkbox" v-model="showArchived" @change="load" />
      Показывать архивные
    </label>

    <table class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500">
        <tr>
          <th class="px-4 py-2">Название</th>
          <th class="px-4 py-2">Расписание</th>
          <th class="px-4 py-2">Кому</th>
          <th class="px-4 py-2">Режим</th>
          <th class="px-4 py-2">Фото</th>
          <th class="px-4 py-2">Статус</th>
          <th class="px-4 py-2"></th>
        </tr>
      </thead>
      <tbody class="divide-y">
        <tr v-for="t in templates" :key="t.id" :class="{ 'text-gray-400': !t.active }">
          <td class="px-4 py-2">{{ t.title }}</td>
          <td class="px-4 py-2">{{ describeSchedule(t.schedule) }}</td>
          <td class="px-4 py-2">{{ assignees(t) }}</td>
          <td class="px-4 py-2">{{ t.distribution === 'each' ? 'Каждому' : 'Одно на всех' }}</td>
          <td class="px-4 py-2">{{ t.requires_photo ? 'Да' : 'Нет' }}</td>
          <td class="px-4 py-2">{{ !t.active ? 'В архиве' : t.schedule ? 'Активно' : 'Разовое' }}</td>
          <td class="px-4 py-2 text-right space-x-2 whitespace-nowrap">
            <RouterLink :to="`/tasks/${t.id}/edit`" class="btn-secondary">Изменить</RouterLink>
            <button class="btn-secondary" @click="toggle(t)">{{ t.active ? 'В архив' : 'Вернуть' }}</button>
            <button class="btn-secondary" :disabled="t.has_instances" :title="t.has_instances ? 'По заданию уже есть история, отправьте его в архив' : ''" @click="remove(t)">Удалить</button>
          </td>
        </tr>
        <tr v-if="templates.length === 0">
          <td colspan="7" class="px-4 py-3 text-gray-500">Пока пусто</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
