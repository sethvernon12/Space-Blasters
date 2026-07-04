// Encouraging one-liners shown under the greeting. Static, math-warm, honest —
// no claims about progress. Chosen deterministically by day so they don't flicker.
export const ENCOURAGEMENTS: string[] = [
  'Every problem you solve makes the next one easier.',
  'Small steps every day add up to big wins.',
  'Mistakes are just practice in disguise — keep going.',
  'Your brain grows every time you try something tricky.',
  'Ready to blast through some math today?',
  'Steady and curious beats fast and rushed.',
  'One good practice session is a great place to start.',
  'You’ve got this — take it one problem at a time.',
  'Numbers are friends once you get to know them.',
  'Show up, try hard, be kind to yourself.',
  'Curiosity is your superpower. Use it today.',
  'A little practice now is a gift to future you.',
]

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0)
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Math.floor((now - start) / 86_400_000)
}

export function encouragementOfTheDay(now: Date = new Date()): string {
  return ENCOURAGEMENTS[dayOfYear(now) % ENCOURAGEMENTS.length]
}

export function greetingFor(now: Date = new Date()): string {
  const h = now.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}
