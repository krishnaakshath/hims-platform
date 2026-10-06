// SAFETY (see the plan's Global Constraints "Mock-payment safety rule"):
// this is a fake, purely arithmetic checksum -- it is NOT a real card
// validity, funds, or fraud check. A number that satisfies the Luhn
// algorithm is treated as "success"; anything else is "failed". No card
// data is ever sent anywhere for real validation.
export function luhnCheck(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '')
  if (digits.length < 12) return false

  let sum = 0
  let shouldDouble = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10)
    if (shouldDouble) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    shouldDouble = !shouldDouble
  }
  return sum % 10 === 0
}
