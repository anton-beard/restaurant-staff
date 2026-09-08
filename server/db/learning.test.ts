import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './connect.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import { getCourse, getLesson, listCourses, listLessons, listPublishedCourses, publishCourse, setCourseStatus, updateCourse } from './courses.js'
import { getCourseQuiz, listDueQuizzes, listQuestions, listQuizzes, replaceQuestions, setQuizStatus, updateQuiz } from './quizzes.js'
import {
  advanceLesson, completeCourseAssignment, createAttempt, createCourseAssignment, createQuizAssignment, finishAttempt,
  getAttempt, getCourseAssignment, getOpenAttempt, hasCourseAssignment, listAttempts, listCourseAssignments,
  listCourseOverdueCandidates, listCourseReminderCandidates, listEmployeeCourseAssignments, listEmployeeQuizAssignments,
  listQuizAssignments, listQuizOverdueCandidates, listQuizReminderCandidates, markQuizPassed, recordAnswer,
} from './learningAssignments.js'

const NOW = '2026-09-07T10:00:00.000Z'
let db: Db
let seed: ReturnType<typeof seedRestaurant>

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
})

describe('courses and lessons', () => {
  it('creates a course with lessons and a course quiz, publishes it', () => {
    const { course, quiz } = seedCourse(db, [seed.positions.barista.id])
    expect(course).toMatchObject({ status: 'draft', lesson_count: 3, position_ids: [seed.positions.barista.id], pass_score: 80 })
    expect(listLessons(db, course.id).map((l) => l.position)).toEqual([1, 2, 3])
    expect(getLesson(db, course.id, 2)?.media).toEqual([{ kind: 'image', path: 'lessons/test.jpg' }, { kind: 'video', url: 'https://youtu.be/x' }])
    expect(getCourseQuiz(db, course.id)?.id).toBe(quiz.id)
    expect(quiz.question_count).toBe(2)
    expect(listPublishedCourses(db)).toEqual([])
    const published = publishCourse(db, course.id, true, NOW)!
    expect(published).toMatchObject({ status: 'published', published_at: NOW, assign_existing: true })
    expect(listPublishedCourses(db)).toHaveLength(1)
    setCourseStatus(db, course.id, 'archived')
    expect(listCourses(db)).toEqual([])
    expect(listCourses(db, { includeArchived: true })).toHaveLength(1)
  })

  it('updates course fields, positions, lessons and questions', () => {
    const { course, quiz } = seedCourse(db, [seed.positions.barista.id])
    const u = updateCourse(db, course.id, { title: 'Эспрессо', description: '', due_days: 3, pass_score: 90, position_ids: [seed.positions.cook.id] })!
    expect(u).toMatchObject({ title: 'Эспрессо', due_days: 3, pass_score: 90, position_ids: [seed.positions.cook.id] })
    replaceQuestions(db, quiz.id, [{ text: 'Один?', options: ['да', 'нет'], correct_index: 0 }])
    expect(listQuestions(db, quiz.id)).toHaveLength(1)
    expect(getCourse(db, 999)).toBeNull()
  })
})

describe('standalone quizzes', () => {
  it('lists standalone quizzes only and finds due ones', () => {
    seedCourse(db, [seed.positions.barista.id])
    const quiz = seedQuiz(db, [seed.positions.barista.id, seed.positions.cook.id])
    expect(listQuizzes(db).map((q) => q.id)).toEqual([quiz.id])
    expect(quiz.schedule).toEqual({ kind: 'weekly', days: [1], times: ['10:00'] })
    expect(listDueQuizzes(db, NOW)).toEqual([])
    setQuizStatus(db, quiz.id, 'published', '2026-09-07T07:00:00.000Z')
    expect(listDueQuizzes(db, NOW).map((q) => q.id)).toEqual([quiz.id])
    updateQuiz(db, quiz.id, { title: 'Меню', course_id: null, pass_score: 70, schedule: null, deadline_minutes: 60, position_ids: [] }, null)
    expect(listDueQuizzes(db, NOW)).toEqual([])
  })
})

describe('course assignments', () => {
  it('assigns once, advances lessons, completes', () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const a = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: '2026-09-14T10:00:00.000Z' })!
    expect(a).toMatchObject({ current_lesson: 1, status: 'in_progress' })
    expect(createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: NOW })).toBeNull()
    expect(hasCourseAssignment(db, course.id, seed.employees.ivan.id)).toBe(true)
    expect(listEmployeeCourseAssignments(db, seed.employees.ivan.id)[0]).toMatchObject({ title: 'Эспрессо по стандарту', lesson_count: 3, employee_name: 'Иван Петров' })
    expect(advanceLesson(db, a.id, 1)).toBe(true)
    expect(advanceLesson(db, a.id, 1)).toBe(false)
    expect(getCourseAssignment(db, a.id)?.current_lesson).toBe(2)
    completeCourseAssignment(db, a.id, NOW)
    expect(getCourseAssignment(db, a.id)).toMatchObject({ status: 'completed', completed_at: NOW })
    expect(listCourseAssignments(db, { status: 'completed' })).toHaveLength(1)
  })

  it('reminder and overdue candidates', () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const soon = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: '2026-09-08T10:00:00.000Z' })!
    const late = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.anna.id, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-06T10:00:00.000Z' })!
    expect(listCourseReminderCandidates(db, NOW).map((x) => x.id)).toEqual([soon.id])
    expect(listCourseOverdueCandidates(db, NOW).map((x) => x.id)).toEqual([late.id])
  })
})

describe('quiz assignments and attempts', () => {
  it('runs an attempt question by question and finishes it', () => {
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const a = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: NOW, assigned_at: NOW, due_at: '2026-09-07T18:00:00.000Z' })!
    expect(createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: NOW, assigned_at: NOW, due_at: NOW })).toBeNull()
    expect(listEmployeeQuizAssignments(db, seed.employees.ivan.id)[0]).toMatchObject({ title: 'Меню недели', open_attempt_id: null })
    expect(getOpenAttempt(db, a.id)).toBeNull()
    const attempt = createAttempt(db, a.id, NOW)
    expect(() => createAttempt(db, a.id, NOW)).toThrow(/open attempt/)
    expect(listEmployeeQuizAssignments(db, seed.employees.ivan.id)[0]?.open_attempt_id).toBe(attempt.id)
    expect(recordAnswer(db, attempt.id, 2, 0)).toBe(false)
    expect(recordAnswer(db, attempt.id, 1, 1)).toBe(true)
    expect(recordAnswer(db, attempt.id, 1, 0)).toBe(false)
    expect(getAttempt(db, attempt.id)).toMatchObject({ current_question: 2, answers: [1] })
    expect(recordAnswer(db, attempt.id, 2, 0)).toBe(true)
    finishAttempt(db, attempt.id, 100, true, NOW)
    expect(getAttempt(db, attempt.id)).toMatchObject({ finished_at: NOW, score: 100, passed: true })
    expect(recordAnswer(db, attempt.id, 3, 0)).toBe(false)
    expect(getOpenAttempt(db, a.id)).toBeNull()
    markQuizPassed(db, a.id, NOW)
    expect(listQuizAssignments(db, { status: 'passed' })).toHaveLength(1)
    expect(listAttempts(db, a.id)).toHaveLength(1)
    expect(listEmployeeQuizAssignments(db, seed.employees.ivan.id)).toEqual([])
  })

  it('reminder and overdue candidates', () => {
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const soon = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: NOW, assigned_at: NOW, due_at: '2026-09-07T18:00:00.000Z' })!
    const late = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.anna.id, course_assignment_id: null, slot_at: '2026-09-06T10:00:00.000Z', assigned_at: '2026-09-06T10:00:00.000Z', due_at: '2026-09-06T18:00:00.000Z' })!
    expect(listQuizReminderCandidates(db, NOW).map((x) => x.id)).toEqual([soon.id])
    expect(listQuizOverdueCandidates(db, NOW).map((x) => x.id)).toEqual([late.id])
  })
})
