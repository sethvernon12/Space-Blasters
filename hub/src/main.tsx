import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App'
import { AuthProvider } from './lib/auth'
import { PreferencesProvider } from './lib/prefs'
import Home from './pages/Home'
import Progress from './pages/Progress'
import Practice from './pages/Practice'
import Play from './pages/Play'
import Assignments from './pages/Assignments'
import Messages from './pages/Messages'
import Settings from './pages/Settings'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreferencesProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<App />}>
              <Route index element={<Home />} />
              <Route path="practice" element={<Practice />} />
              <Route path="play" element={<Play />} />
              <Route path="progress" element={<Progress />} />
              <Route path="assignments" element={<Assignments />} />
              <Route path="messages" element={<Messages />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </PreferencesProvider>
  </StrictMode>,
)
