import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App'
import { AuthProvider } from './lib/auth'
import Home from './pages/Home'
import Progress from './pages/Progress'
import Assignments from './pages/Assignments'
import Practice from './pages/Practice'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<App />}>
            <Route index element={<Home />} />
            <Route path="progress" element={<Progress />} />
            <Route path="assignments" element={<Assignments />} />
            <Route path="practice" element={<Practice />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
)
