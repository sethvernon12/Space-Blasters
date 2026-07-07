// Output choke point — EVERY generated string passes through here before it can
// reach a parent or child. Blocks links / emails / phone-like PII (defence in
// depth even though the mock can't produce them; the seam guards real providers).
export function moderate(text: string): { text: string; flagged: boolean } {
  const bad = /(https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[\w.-]+\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/i
  return bad.test(text)
    ? { text: 'A progress summary is available — see the skill details below.', flagged: true }
    : { text, flagged: false }
}
