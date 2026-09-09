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
import CoursesPage from './pages/CoursesPage.vue'
import CourseForm from './pages/CourseForm.vue'
import QuizzesPage from './pages/QuizzesPage.vue'
import QuizForm from './pages/QuizForm.vue'
import ProgressPage from './pages/ProgressPage.vue'
import DashboardPage from './pages/DashboardPage.vue'
import EmployeePage from './pages/EmployeePage.vue'

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
        { path: '', component: DashboardPage },
        { path: 'tasks', component: TemplatesPage },
        { path: 'tasks/new', component: TemplateForm },
        { path: 'tasks/:id/edit', component: TemplateForm, props: true },
        { path: 'journal', component: InstancesPage },
        { path: 'review', component: ReviewPage },
        { path: 'employees', component: EmployeesPage },
        { path: 'employees/:id', component: EmployeePage, props: true },
        { path: 'positions', component: PositionsPage },
        { path: 'learning/courses', component: CoursesPage },
        { path: 'learning/courses/new', component: CourseForm },
        { path: 'learning/courses/:id/edit', component: CourseForm, props: true },
        { path: 'learning/quizzes', component: QuizzesPage },
        { path: 'learning/quizzes/new', component: QuizForm },
        { path: 'learning/quizzes/:id/edit', component: QuizForm, props: true },
        { path: 'learning/progress', component: ProgressPage },
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
