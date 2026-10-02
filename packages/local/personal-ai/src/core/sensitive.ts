/**
 * Sensitive-content detection for memory. Secret token formats come from the
 * orchestration redactor (one pattern list for the whole app); this adds the
 * ways people share credentials and personal identifiers in plain words.
 */
import { redact } from '@local/main-agents'

/** Why a text may not become memory. */
export interface SensitiveFinding {
  readonly sensitive: boolean
  readonly reason?: string
}

const CREDENTIAL_PHRASE = new RegExp(String.raw`\b(?:password|passcode|passphrase|pass word|pin(?: code)?|api[ _-]?key|secret(?: key)?|access token|auth token|bearer token|private key|seed phrase|recovery phrase|2fa code|otp|one[- ]time code)\b\s*(?:is|was|=|:|for\b)`, 'i')
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const CARD = /\b(?:\d[ -]?){13,19}\b/
const SSN = /\b\d{3}-\d{2}-\d{4}\b/
const IDENTITY = /\b(?:social security|ssn|credit card|card number|cvv|cvc|bank account|routing number|iban|passport number)\b/i
const HIGH_ENTROPY = /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{32,}\b/

function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Check whether text contains a secret or sensitive personal identifier.
 * @param text - candidate memory text.
 * @returns finding with a reason when sensitive.
 */
export function findSensitive(text: string): SensitiveFinding {
  if (redact(text) !== text) return { sensitive: true, reason: 'contains an API key or token' }
  if (PRIVATE_KEY.test(text)) return { sensitive: true, reason: 'contains a private key' }
  if (CREDENTIAL_PHRASE.test(text)) return { sensitive: true, reason: 'looks like a password or credential' }
  if (SSN.test(text)) return { sensitive: true, reason: 'looks like a social security number' }
  const card = CARD.exec(text)?.[0].replaceAll(/\D/g, '')
  if (card !== undefined && card.length >= 13 && luhn(card)) return { sensitive: true, reason: 'looks like a payment card number' }
  if (IDENTITY.test(text) && /\d{4,}/.test(text)) return { sensitive: true, reason: 'contains a financial or identity number' }
  if (HIGH_ENTROPY.test(text)) return { sensitive: true, reason: 'contains a long random-looking string that may be a secret' }
  return { sensitive: false }
}
