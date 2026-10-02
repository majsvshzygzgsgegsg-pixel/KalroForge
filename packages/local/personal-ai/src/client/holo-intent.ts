/**
 * The spoken or typed shortcut for Holo Hands. Only a whole request that is
 * just "open holo hands" (or "close …") matches, including the ways speech
 * recognition tends to hear "holo"; anything longer goes to KairoForge, which
 * has the open_holo tool.
 */

const NAME = String.raw`(?:(?:holo|hollow|halo|hollo|holla|hola)(?:\s*(?:hands?|gestures?|deck))?|hello\s+(?:hands?|gestures?))`
const LEAD = String.raw`^(?:(?:hey|hi|ok|okay|yo)\s+[\p{L}-]+[,!.]?\s+)?(?:(?:please|can you|could you|would you)\s+)?`
const TAIL = String.raw`(?:\s+(?:please|now|for me))?[\s.!?]*$`
const OPEN = new RegExp(`${LEAD}(?:open|launch|start|show|bring up|pull up|turn on|load)\\s+(?:up\\s+)?(?:the\\s+|my\\s+)?${NAME}${TAIL}`, 'iu')
const CLOSE = new RegExp(`${LEAD}(?:close|exit|hide|shut|quit|turn off|leave)\\s+(?:down\\s+)?(?:the\\s+|my\\s+)?${NAME}${TAIL}`, 'iu')

/**
 * Whether a request is exactly the Holo Hands shortcut.
 * @param text - what the user said or typed.
 * @returns "open", "close", or undefined.
 */
export function holoShortcut(text: string): 'open' | 'close' | undefined {
  const trimmed = text.trim()
  if (OPEN.test(trimmed)) return 'open'
  if (CLOSE.test(trimmed)) return 'close'
  return undefined
}
