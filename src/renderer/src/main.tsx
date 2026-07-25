import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './assets/index.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root missing from index.html')

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>
)
