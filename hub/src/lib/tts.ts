// Minimal, dependency-free read-aloud via the Web Speech API. Fails silently
// where unsupported. No audio is stored or transmitted.
export function speak(text: string): void {
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 0.95
    u.pitch = 1
    synth.speak(u)
  } catch { /* ignore */ }
}

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}
