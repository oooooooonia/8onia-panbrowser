export function formatSize(n) {
  if (n === 0) return '—'
  if (n == null || Number.isNaN(n)) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Number(n)
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const VIDEO_EXTS = [
  'mp4', 'mkv', 'mov', 'm4v', 'webm', 'ts', 'm2ts', 'flv', 'avi', 'wmv',
  'rmvb', 'rm', 'mpg', 'mpeg', 'vob', '3gp', 'f4v', 'asf', 'divx', 'ogv', 'mts'
]
export const AUDIO_EXTS = ['mp3', 'aac', 'flac', 'wav', 'ogg', 'm4a', 'opus', 'wma', 'ape']

export const VIP_NAME = { 0: '普通用户', 1: '普通会员', 2: '超级会员' }

/** 秒 → m:ss / h:mm:ss */
export function formatClock(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const pad = (x) => String(x).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function shortPath(p) {
  const parts = String(p || '/').split('/').filter(Boolean)
  if (parts.length <= 2) return p
  return `…/${parts.slice(-2).join('/')}`
}
