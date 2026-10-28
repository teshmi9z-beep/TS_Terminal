import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LANG } from './i18n/lang'

// in English the translator is in place before the first screen is drawn
const ready = LANG === 'en' ? import('./i18n/translate').then((m) => m.startTranslation()) : Promise.resolve()

void ready.then(() => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
))
