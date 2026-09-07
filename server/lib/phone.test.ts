import { describe, expect, it } from 'vitest'
import { normalizePhone } from './phone.js'

describe('normalizePhone', () => {
  it.each([
    ['+7 (999) 123-45-67', '+79991234567'],
    ['8 999 123 45 67', '+79991234567'],
    ['9991234567', '+79991234567'],
    ['79991234567', '+79991234567'],
    ['+380501234567', '+380501234567'],
    ['380501234567', '+380501234567'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected)
  })

  it.each([['', null], ['abc', null], ['12345', null], ['+1234567890123456', null]])(
    'rejects %s',
    (input, expected) => {
      expect(normalizePhone(input)).toBe(expected)
    },
  )
})
