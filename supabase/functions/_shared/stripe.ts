// _shared/stripe.ts — the ONE door for creating a consent Checkout Session.
// FAIL-CLOSED mock (same doctrine as the AI gateway): with no STRIPE_SECRET_KEY +
// STRIPE_CONSENT_PRICE_ID configured, it returns a deterministic MOCK url and
// NEVER touches Stripe / never charges. A real hosted Checkout Session is created
// ONLY when both are explicitly set (the DEV/staging gate). Card data is entered
// only on Stripe's page — never here.
export async function createConsentCheckout(opts: { metadata: Record<string, string>; successUrl: string; cancelUrl: string }): Promise<{ url: string; mock: boolean }> {
  const secret = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
  const price = Deno.env.get('STRIPE_CONSENT_PRICE_ID') ?? ''
  if (!secret || !price) {
    // MOCK: return straight to the hub's success_url; the webhook is exercised
    // separately in tests. No Stripe call, no charge.
    const sep = opts.successUrl.includes('?') ? '&' : '?'
    return { url: `${opts.successUrl}${sep}mock=1`, mock: true }
  }
  const form = new URLSearchParams()
  form.set('mode', 'payment')
  form.set('line_items[0][price]', price)
  form.set('line_items[0][quantity]', '1')
  form.set('success_url', opts.successUrl)
  form.set('cancel_url', opts.cancelUrl)
  for (const [k, v] of Object.entries(opts.metadata)) form.set(`metadata[${k}]`, v)
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!res.ok) throw new Error('stripe_error')
  const sess = await res.json()
  if (!sess?.url) throw new Error('stripe_no_url')
  return { url: sess.url, mock: false }
}
