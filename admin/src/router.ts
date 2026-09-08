import { createRouter, createWebHistory } from 'vue-router'
import { api } from './api'
import AppLayout from './components/AppLayout.vue'
import LoginPage from './pages/LoginPage.vue'
import EmployeesPage from './pages/EmployeesPage.vue'
import PositionsPage from './pages/PositionsPage.vue'
import TemplatesPage from './pages/TemplatesPage.vue'
import TemplateForm from './pages/TemplateForm.vue'
import InstancesPage from './pages/InstancesPage.vue'
import ReviewPage from './pages/ReviewPage.vue'

let authed = false
export function setAuthed(value: boolean) {
  authed = value
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginPage },
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', redirect: '/tasks' },
        { path: 'tasks', component: TemplatesPage },
        { path: 'tasks/new', component: TemplateForm },
        { path: 'tasks/:id/edit', component: TemplateForm, props: true },
        { path: 'journal', component: InstancesPage },
        { path: 'review', component: ReviewPage },
        { path: 'employees', component: EmployeesPage },
        { path: 'positions', component: PositionsPage },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  if (to.path === '/login') return true
  if (authed) return true
  try {
    await api.me()
    authed = true
    return true
  } catch {
    return '/login'
  }
})
