import { describe, expect, it } from 'vitest'
import type { Question } from '../db/quizzes.js'
import { isPassed, scoreAnswers } from './score.js'

const q = (position: number, correct: number): Question => ({ id: position, quiz_id: 1, position, text: 'q', options: ['a', 'b', 'c'], correct_index: correct })

describe('scoreAnswers', () => {
  it('counts correct answers by question order and rounds the percentage', () => {
    const questions = [q(1, 1), q(2, 0), q(3, 2)]
    expect(scoreAnswers([1, 0, 2], questions)).toEqual({ correct: 3, total: 3, score: 100 })
    expect(scoreAnswers([1, 1, 1], questions)).toEqual({ correct: 1, total: 3, score: 33 })
    expect(scoreAnswers([0, 0, 0], questions)).toEqual({ correct: 1, total: 3, score: 33 })
    expect(scoreAnswers([], questions)).toEqual({ correct: 0, total: 3, score: 0 })
  })
  it('isPassed compares with the pass score inclusively', () => {
    expect(isPassed(80, 80)).toBe(true)
    expect(isPassed(79, 80)).toBe(false)
  })
})
