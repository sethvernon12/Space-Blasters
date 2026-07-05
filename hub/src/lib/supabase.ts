import { createClient } from '@supabase/supabase-js'

// The ONLY Supabase client in the hub. Uses the publishable/anon key + the
// signed-in user's JWT (set by GoTrue after sign-in) — RLS scopes every read.
// No service-role key exists anywhere in this app. __SUPABASE_URL__ /
// __SUPABASE_PUBLISHABLE_KEY__ are build-time constants: a LOCAL stack via
// hub/.env.local, or the live-game default otherwise (see vite.config.ts).
export const supabase = createClient(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sg_hub_session' },
})
