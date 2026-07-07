// _shared/moderate.ts — output choke point (KER-5): EVERY child-facing string
// passes through here; blocks links / emails / phone-like PII.
export function moderate(text: string): { text: string; flagged: boolean } {
  const bad = /(https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[\w.-]+\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/i
  return bad.test(text)
    ? { text: 'A progress note is available — see the teacher’s notes.', flagged: true }
    : { text, flagged: false }
}
