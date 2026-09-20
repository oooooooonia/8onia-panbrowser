/**
 * 已抽取的内嵌字幕（ASS）文本缓存。
 *
 * 播放器为了显示内嵌字幕，本来就会让服务端用 ffmpeg 把整条字幕轨抽出来（实测 1GB 文件约 131s）。
 * 这里把抽取结果留存一份，OP/ED 检测直接复用 —— 否则再抽一遍会和字幕显示抢百度带宽，
 * 导致字幕迟迟加载不出来（这正是之前“字幕不见了”的根因）。
 */
const TTL = 60 * 60 * 1000 // 1 小时
const MAX_ENTRIES = 8
const store = new Map() // `${videoPath}|${index}` -> { text, at }

const keyOf = (videoPath, index) => `${videoPath}|${index}`

function prune() {
  const now = Date.now()
  for (const [k, v] of store) {
    if (now - v.at > TTL) store.delete(k)
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (!oldest) break
    store.delete(oldest[0])
  }
}

export function putAssText(videoPath, index, text) {
  if (!videoPath || !text) return
  store.set(keyOf(videoPath, index), { text: String(text), at: Date.now() })
  prune()
}

export function getAssText(videoPath, index) {
  const hit = store.get(keyOf(videoPath, index))
  if (!hit) return ''
  if (Date.now() - hit.at > TTL) {
    store.delete(keyOf(videoPath, index))
    return ''
  }
  return hit.text
}

/** 该视频已缓存的所有字幕轨（用于「播放器加载了哪条就用哪条」） */
export function getAnyAssText(videoPath) {
  const out = []
  for (const [k, v] of store) {
    if (k.startsWith(videoPath + '|') && Date.now() - v.at <= TTL) {
      out.push({ index: Number(k.slice(videoPath.length + 1)), text: v.text })
    }
  }
  return out
}

export function clearAssCache() {
  store.clear()
}
