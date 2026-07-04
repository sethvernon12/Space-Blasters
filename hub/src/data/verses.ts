// Verse of the Day — a curated, kid-friendly, encouraging set. Chosen
// deterministically by day so it's stable within a day and rotates over time.
export interface Verse {
  text: string
  reference: string
}

export const VERSES: Verse[] = [
  { text: 'I can do all things through Christ who gives me strength.', reference: 'Philippians 4:13' },
  { text: 'Be strong and courageous. Do not be afraid, for the Lord your God is with you wherever you go.', reference: 'Joshua 1:9' },
  { text: 'Trust in the Lord with all your heart.', reference: 'Proverbs 3:5' },
  { text: 'Whatever you do, work at it with all your heart.', reference: 'Colossians 3:23' },
  { text: 'The Lord is my strength and my shield; my heart trusts in him.', reference: 'Psalm 28:7' },
  { text: 'Let all that you do be done in love.', reference: '1 Corinthians 16:14' },
  { text: 'This is the day the Lord has made; let us rejoice and be glad in it.', reference: 'Psalm 118:24' },
  { text: 'Give thanks to the Lord, for he is good.', reference: 'Psalm 107:1' },
  { text: 'A cheerful heart is good medicine.', reference: 'Proverbs 17:22' },
  { text: 'Do everything without grumbling.', reference: 'Philippians 2:14' },
  { text: 'Your word is a lamp to my feet and a light to my path.', reference: 'Psalm 119:105' },
  { text: 'Wait for the Lord; be strong and take heart.', reference: 'Psalm 27:14' },
  { text: 'Love is patient, love is kind.', reference: '1 Corinthians 13:4' },
  { text: 'The Lord will guide you always.', reference: 'Isaiah 58:11' },
  { text: 'God is our refuge and strength, an ever-present help.', reference: 'Psalm 46:1' },
  { text: 'Let your light shine before others.', reference: 'Matthew 5:16' },
  { text: 'Cast all your cares on him, because he cares for you.', reference: '1 Peter 5:7' },
  { text: 'In everything give thanks.', reference: '1 Thessalonians 5:18' },
  { text: 'The joy of the Lord is your strength.', reference: 'Nehemiah 8:10' },
  { text: 'Be kind to one another, tenderhearted.', reference: 'Ephesians 4:32' },
  { text: 'I praise you, for I am fearfully and wonderfully made.', reference: 'Psalm 139:14' },
  { text: 'Do not be anxious about anything.', reference: 'Philippians 4:6' },
  { text: 'The Lord is good to those whose hope is in him.', reference: 'Lamentations 3:25' },
  { text: 'Let us not grow weary in doing good.', reference: 'Galatians 6:9' },
  { text: 'Every good and perfect gift is from above.', reference: 'James 1:17' },
  { text: 'The heavens declare the glory of God.', reference: 'Psalm 19:1' },
  { text: 'Rejoice always, pray continually.', reference: '1 Thessalonians 5:16-17' },
  { text: 'With God all things are possible.', reference: 'Matthew 19:26' },
  { text: 'He gives strength to the weary.', reference: 'Isaiah 40:29' },
  { text: 'Commit to the Lord whatever you do, and he will establish your plans.', reference: 'Proverbs 16:3' },
  { text: 'The Lord your God is with you, the Mighty Warrior who saves.', reference: 'Zephaniah 3:17' },
  { text: 'Great is the Lord and most worthy of praise.', reference: 'Psalm 145:3' },
]

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0)
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Math.floor((now - start) / 86_400_000)
}

/** Deterministic verse for the given day (defaults to today). */
export function verseOfTheDay(now: Date = new Date()): Verse {
  return VERSES[dayOfYear(now) % VERSES.length]
}
