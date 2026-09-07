<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type Position } from '../api'

const positions = ref<Position[]>([])
const newName = ref('')
const error = ref('')

async function load() {
  try {
    positions.value = await api.positions.list()
  } catch (err) {
    error.value = errorText(err)
  }
}

async function add() {
  error.value = ''
  try {
    await api.positions.create(newName.value)
    newName.value = ''
    await load()
  } catch (err) {
    error.value = errorText(err, { conflict: 'Такая должность уже есть.' })
  }
}

async function rename(p: Position) {
  const name = window.prompt('Новое название', p.name)?.trim()
  if (!name || name === p.name) return
  error.value = ''
  try {
    await api.positions.rename(p.id, name)
    await load()
  } catch (err) {
    error.value = errorText(err, { conflict: 'Такая должность уже есть.' })
  }
}

async function remove(p: Position) {
  if (!window.confirm(`Удалить должность «${p.name}»?`)) return
  error.value = ''
  try {
    await api.positions.remove(p.id)
    await load()
  } catch (err) {
    error.value = errorText(err, { in_use: 'Должность назначена сотрудникам, удалить нельзя.' })
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Должности</h1>

    <form class="flex gap-2" @submit.prevent="add">
      <input v-model="newName" class="input max-w-xs" placeholder="Например, Официант" required />
      <button class="btn">Добавить</button>
    </form>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <ul class="bg-white rounded-xl shadow divide-y">
      <li v-for="p in positions" :key="p.id" class="flex items-center px-4 py-2 gap-2">
        <span class="flex-1">{{ p.name }}</span>
        <button class="btn-secondary" @click="rename(p)">Переименовать</button>
        <button class="btn-secondary" @click="remove(p)">Удалить</button>
      </li>
      <li v-if="positions.length === 0" class="px-4 py-3 text-sm text-gray-500">Пока пусто</li>
    </ul>
  </div>
</template>
