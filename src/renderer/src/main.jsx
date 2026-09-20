import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { reportThrottled } from './lib/api'

// 全局错误/异常上报（写入 App 内置 debug.log，便于排查手机端字幕/播放问题）
window.addEventListener('error', (e) => {
  reportThrottled('winerr: ' + ((e.error && e.error.stack) || e.message || '').slice(0, 1000))
})
window.addEventListener('unhandledrejection', (e) => {
  reportThrottled('rejerr: ' + ((e.reason && e.reason.stack) || String(e.reason)).slice(0, 1000))
})
const origError = console.error
console.error = (...a) => {
  try {
    origError.apply(console, a)
    reportThrottled('console.error: ' + a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 1000))
  } catch { /* ignore */ }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
