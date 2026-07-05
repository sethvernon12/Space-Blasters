import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { PreferencesProvider } from './lib/prefs'
import { SessionProvider } from './lib/session'
import Root from './Root'

// Milestone 3: role-aware family hub. A dev "Sign in as…" switcher (local GoTrue
// sessions) resolves the signed-in user's role and renders their home. Real
// Google OAuth is added at the DEV-promotion step.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreferencesProvider>
      <SessionProvider>
        <Root />
      </SessionProvider>
    </PreferencesProvider>
  </StrictMode>,
)
