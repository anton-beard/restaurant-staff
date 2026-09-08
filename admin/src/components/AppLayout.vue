<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import { setAuthed } from '../router'
import { refreshReviewCount, reviewCount } from '../reviewCount'

const router = useRouter()

let timer: number | undefined
onMounted(() => {
  void refreshReviewCount()
  timer = window.setInterval(() => void refreshReviewCount(), 60_000)
})
onUnmounted(() => window.clearInterval(timer))

async function logout() {
  await api.logout().catch(() => undefined)
  setAuthed(false)
  await router.push('/login')
}
</script>

<template>
  <div class="min-h-screen">
    <header class="bg-white border-b">
      <nav class="max-w-5xl mx-auto px-4 h-14 flex items-center gap-6">
        <span class="font-semibold">Ресторан</span>
        <RouterLink to="/tasks" class="text-sm hover:underline" active-class="font-semibold">Задания</RouterLink>
        <RouterLink to="/journal" class="text-sm hover:underline" active-class="font-semibold">Журнал</RouterLink>
        <RouterLink to="/review" class="text-sm hover:underline" active-class="font-semibold">
          Проверка фото
          <span v-if="reviewCount" class="ml-1 rounded-full bg-red-600 text-white text-xs px-2 py-0.5">{{ reviewCount }}</span>
        </RouterLink>
        <RouterLink to="/employees" class="text-sm hover:underline" active-class="font-semibold">
          Сотрудники
        </RouterLink>
        <RouterLink to="/positions" class="text-sm hover:underline" active-class="font-semibold">
          Должности
        </RouterLink>
        <button class="ml-auto text-sm text-gray-500 hover:underline" @click="logout">Выйти</button>
      </nav>
    </header>
    <main class="max-w-5xl mx-auto p-4">
      <RouterView />
    </main>
  </div>
</template>
