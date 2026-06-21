/*
 * Word → symbol mapping for tiles in symbolMode (autistic + aphasia profiles).
 *
 * Why emoji and not bespoke PECS pictograms? PECS imagery is proprietary, and
 * Unicode emoji render universally on every device without bundling assets.
 * If/when we partner with a symbol set provider (ARASAAC is open-source AAC
 * imagery), swap this for an asset URL map.
 *
 * Matching is normalized (lowercase, trimmed, single-spaced). Multi-word
 * concepts get checked first, then individual words.
 */

const MAP = {
  // Core acknowledgements
  'yes': '✅', 'no': '❌', 'maybe': '🤔', 'okay': '👍', 'ok': '👍',
  "i don't know": '🤷', 'not sure': '🤷', 'not really': '🙅',

  // Politeness
  'thank you': '🙏', 'thanks': '🙏', 'please': '🙏', 'sorry': '😔',
  "you're welcome": '😊',

  // Needs
  'help': '🆘', 'water': '💧', 'food': '🍽️', 'hungry': '🍽️', 'thirsty': '💧',
  'bathroom': '🚻', 'toilet': '🚻', 'medicine': '💊', 'rest': '🛏️', 'sleep': '🛌',
  'more': '➕', 'stop': '🛑', 'wait': '⏸️', 'go': '▶️',

  // Feelings
  'happy': '😊', 'sad': '😢', 'tired': '😴', 'sleepy': '😴',
  'angry': '😠', 'frustrated': '😤', 'scared': '😨', 'anxious': '😟',
  'excited': '😄', 'calm': '😌', 'pain': '😣', 'hurt': '🤕',
  'love': '❤️', 'good': '👍', 'bad': '👎', 'fine': '🙂',
  'feeling better': '🙂', 'not great': '😕',

  // People & places
  'family': '👨‍👩‍👧', 'mom': '👩', 'dad': '👨', 'sister': '👧', 'brother': '👦',
  'doctor': '🩺', 'nurse': '🩺', 'friend': '🫂', 'home': '🏠', 'school': '🏫',
  'work': '💼', 'phone': '📱',

  // Time
  'now': '⏰', 'later': '⏳', 'today': '📅', 'tomorrow': '📆', 'yesterday': '📜',
  'in a bit': '⏳', 'soon': '⏳', 'morning': '🌅', 'night': '🌙',

  // Common words
  'with you': '👫', 'with me': '🫂', 'alone': '🚶', 'together': '🤝',
  'i': '👤', 'you': '👋', 'we': '👫', 'us': '👫',
  'eat': '🍽️', 'drink': '🥤', 'play': '🎲', 'read': '📖', 'watch': '👀',
  'walk': '🚶', 'sit': '🪑', 'stand': '🧍',
}

const normalize = (s) => s.toLowerCase().trim().replace(/\s+/g, ' ')

export function symbolFor(text) {
  if (!text) return null
  const key = normalize(text)
  if (MAP[key]) return MAP[key]
  // Try first significant word as fallback
  const words = key.split(' ').filter(w => w.length > 1)
  for (const w of words) {
    if (MAP[w]) return MAP[w]
  }
  return null
}
