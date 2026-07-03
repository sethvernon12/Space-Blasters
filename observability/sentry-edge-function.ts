// Template: Sentry + structured AI-call logging for Supabase Edge Functions (Phase 3+).
// No-op while SENTRY_DSN is unset. NEVER log child PII (CLAUDE.md observability rule).
//
// Usage inside an Edge Function:
//   import { captureError, logAiCall } from '../_shared/sentry.ts';   // copied from this template
//
// deno-lint-ignore-file no-explicit-any

const SENTRY_DSN = Deno.env.get('SENTRY_DSN') ?? '';

export async function captureError(err: unknown, context: Record<string, string> = {}) {
  // context values must be opaque ids/enums only — no nicknames, emails, answers.
  console.error('[error]', JSON.stringify({ message: String(err), ...context }));
  if (!SENTRY_DSN) return;                       // placeholder mode: log-only
  // Phase 3: POST to Sentry's store endpoint or use sentry-deno once functions exist.
}

// Structured log for EVERY AI call: task, model, tokens, cost, latency, child scope —
// child_scope is an OPAQUE uuid; never include problem text, answers, or names here.
export function logAiCall(entry: {
  task: string;            // e.g. 'grade-photo' | 'generate-set' | 'tutor-turn'
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  child_scope: string;     // opaque child uuid (scoping/audit), never a name
  ok: boolean;
}) {
  console.log('[ai-call]', JSON.stringify(entry));
}
