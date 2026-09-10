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

const links = [
  { to: '/tasks', label: 'Задания' },
  { to: '/journal', label: 'Журнал' },
  { to: '/review', label: 'Проверка фото', badge: true },
  { to: '/learning/courses', label: 'Курсы' },
  { to: '/learning/quizzes', label: 'Тесты' },
  { to: '/learning/progress', label: 'Прогресс' },
  { to: '/employees', label: 'Сотрудники' },
  { to: '/positions', label: 'Должности' },
]
</script>

<template>
  <div class="min-h-screen">
    <header class="bg-white border-b sticky top-0 z-10">
      <div class="max-w-5xl mx-auto px-4 flex flex-wrap items-center gap-x-6">
        <RouterLink to="/" class="font-semibold py-2 shrink-0">Ресторан</RouterLink>
        <!-- На телефоне меню отдельной строкой на всю ширину и прокручивается по горизонтали, на широком экране в одну строку с заголовком. -->
        <nav class="nav-scroll order-last w-full md:order-none md:w-auto md:flex-1 flex items-center gap-4 md:gap-6 py-2 border-t md:border-0 -mx-4 px-4 md:mx-0 md:px-0">
          <RouterLink to="/" class="text-sm hover:underline" :class="{ 'font-semibold': $route.path === '/' }">Сводка</RouterLink>
          <RouterLink v-for="l in links" :key="l.to" :to="l.to" class="text-sm hover:underline" active-class="font-semibold">
            {{ l.label }}
            <span v-if="l.badge && reviewCount" class="ml-1 rounded-full bg-red-600 text-white text-xs px-2 py-0.5">{{ reviewCount }}</span>
          </RouterLink>
        </nav>
        <button class="ml-auto text-sm text-gray-500 hover:underline shrink-0 py-2" @click="logout">Выйти</button>
      </div>
    </header>
    <main class="max-w-5xl mx-auto p-4">
      <RouterView />
    </main>
  </div>
</template>
