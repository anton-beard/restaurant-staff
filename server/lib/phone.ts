/** Приводит номер к E.164. Российские номера без кода страны получают +7. */
export function normalizePhone(input: string): string | null {
  const hasPlus = input.trim().startsWith('+')
  const digits = input.replace(/\D/g, '')
  if (digits.length === 0) return null

  let full: string
  if (hasPlus) {
    full = digits
  } else if (digits.length === 11 && digits.startsWith('8')) {
    full = '7' + digits.slice(1)
  } else if (digits.length === 10 && digits.startsWith('9')) {
    full = '7' + digits
  } else {
    full = digits
  }

  if (full.length < 10 || full.length > 15) return null
  return '+' + full
}
