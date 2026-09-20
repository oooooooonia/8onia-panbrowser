/**
 * 字幕信号 → OP/ED 分段。
 *
 * 两条路径：
 *   A) ASS/SSA 样式名：OP/ED 歌词通常有专用样式（OPJP / OPCN / ED-furigana / IN …），
 *      把同一样式族的连续事件聚成一个「歌词块」= OP 或 ED 的精确时间范围。
 *      ⚠️ 样式名不可全信：实测有字幕组把 ED 歌词放在 OPCN/OPJP 样式里，
 *      因此类型最终按「位置」校正（靠前→op，靠后→ed），样式名只作提示。
 *   B) 外挂字幕跨集共享文本：OP/ED 歌词在每集都出现（时间不同、文本相同），
 *      用「同一行文本出现在 ≥2 集」的连续区间定位。
 */

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/

function toSec(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0')) / 1000
}

function assTime(t) {
  const m = String(t || '').trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/)
  if (!m) return NaN
  return toSec(m[1], m[2], m[3], m[4])
}

function normStyle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

const OP_STYLE = /^(?:nc)?op[a-z0-9]{0,12}$/
const ED_STYLE = /^(?:nc)?ed[a-z0-9]{0,12}$/

/** 解析 ASS/SSA 的 Dialogue 事件（兼容 Format 列顺序变化） */
export function parseAss(text) {
  const out = []
  let inEvents = false
  let idx = { style: 3, start: 1, end: 2, text: 9 }
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (/^\[/.test(line)) {
      inEvents = /^\[events\]/i.test(line)
      continue
    }
    if (!inEvents) continue
    if (/^format\s*:/i.test(line)) {
      const cols = line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim().toLowerCase())
      const get = (k, d) => (cols.indexOf(k) >= 0 ? cols.indexOf(k) : d)
      idx = { style: get('style', 3), start: get('start', 1), end: get('end', 2), text: get('text', 9) }
      continue
    }
    if (!/^dialogue\s*:/i.test(line)) continue
    const body = line.slice(line.indexOf(':') + 1)
    const fields = body.split(',')
    const head = fields.slice(0, idx.text)
    const content = fields.slice(idx.text).join(',')
    const start = assTime(head[idx.start])
    const end = assTime(head[idx.end])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    out.push({ start, end, style: (head[idx.style] || '').trim(), text: content })
  }
  return out
}

/** 解析 SRT/SBV 文本事件 */
export function parseSrt(text) {
  const out = []
  for (const blk of String(text || '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = blk.split('\n').filter((l) => l.trim() !== '')
    if (!lines.length) continue
    const ti = lines.findIndex((l) => SRT_TIME.test(l))
    if (ti < 0) continue
    const m = lines[ti].match(SRT_TIME)
    const start = toSec(m[1], m[2], m[3], m[4])
    const end = toSec(m[5], m[6], m[7], m[8])
    const body = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    if (end > start) out.push({ start, end, style: '', text: body })
  }
  return out
}

/** 把连续事件聚成块（间隙 > gap 视为断开） */
function groupBlocks(events, { gap = 12, minEvents = 5, minLen = 20 } = {}) {
  const ev = [...events].sort((a, b) => a.start - b.start)
  const blocks = []
  let cur = null
  for (const e of ev) {
    if (!cur || e.start - cur.end > gap) {
      cur = { start: e.start, end: e.end, n: 1, styles: [e.style] }
      blocks.push(cur)
    } else {
      cur.end = Math.max(cur.end, e.end)
      cur.n++
      cur.styles.push(e.style)
    }
  }
  return blocks.filter((b) => b.n >= minEvents && b.end - b.start >= minLen)
}

function dominantStyle(styles) {
  const tally = new Map()
  for (const s of styles) tally.set(s, (tally.get(s) || 0) + 1)
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0] || ''
}

/**
 * 从 ASS/SSA 文本推断 OP/ED 歌词块。
 * @param {string} text  ASS 文本
 * @param {{duration?:number, offset?:number}} opt  duration 用于位置校正；offset 为抽取窗口起点（时间戳是相对的）
 */
export function analyzeAss(text, { duration = 0, offset = 0 } = {}) {
  const events = parseAss(text).filter((e) => {
    const s = normStyle(e.style)
    return OP_STYLE.test(s) || ED_STYLE.test(s)
  })
  const segments = []
  const candidates = []
  const hints = []
  if (!events.length) return { segments, candidates, hints }

  const blocks = groupBlocks(events)
  for (const b of blocks) {
    const styleRaw = dominantStyle(b.styles)
    const s = normStyle(styleRaw)
    const styleType = OP_STYLE.test(s) ? 'op' : ED_STYLE.test(s) ? 'ed' : ''
    const start = b.start + offset
    const end = b.end + offset
    let type = styleType
    let conf = 0.8
    if (duration > 0) {
      if (start >= duration * 0.7) {
        if (type && type !== 'ed') conf = 0.6
        type = 'ed'
      } else if (start <= duration * 0.4) {
        if (type && type !== 'op') conf = 0.6
        type = 'op'
      }
    }
    if (!type) continue
    if (type !== styleType && styleType) {
      hints.push(`字幕样式名「${styleRaw}」与位置不符（位于 ${fmt(start)}），已按位置判定为 ${type.toUpperCase()}`)
    }
    const seg = { type, start, end, title: `字幕样式 ${styleRaw}`, source: 'subtitle', confidence: conf, events: b.n }
    segments.push(seg)
    candidates.push({ ...seg })
  }
  // 同一类型只保留最长的块
  return { segments: dedupeLongest(segments), candidates, hints }
}

/** 跨集共享文本（外挂字幕）：出现在 ≥minFiles 集里的文本行 → 连续块 */
export function analyzeSharedText(entries, { duration = 0, minFiles = 2 } = {}) {
  // entries: [{ events, offset }]
  const maps = entries.map((e) => {
    const m = new Map()
    for (const ev of e.events || []) {
      const key = normalizeLine(ev.text)
      if (!key || key.length < 2) continue
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(ev)
    }
    return m
  })
  if (maps.length < minFiles) return { segments: [], hints: [] }

  const segments = []
  for (let i = 0; i < maps.length; i++) {
    const shared = []
    for (const [key, evs] of maps[i]) {
      let n = 1
      for (let j = 0; j < maps.length; j++) {
        if (j !== i && maps[j].has(key)) n++
      }
      if (n >= minFiles) shared.push(...evs)
    }
    if (shared.length < 5) continue
    const blocks = groupBlocks(shared.map((e) => ({ ...e, style: '' })), { minEvents: 5, minLen: 25 })
    for (const b of blocks) {
      const start = b.start + (entries[i].offset || 0)
      const end = b.end + (entries[i].offset || 0)
      let type = ''
      if (duration > 0) type = start >= duration * 0.7 ? 'ed' : start <= duration * 0.4 ? 'op' : ''
      if (!type) continue
      segments.push({
        type,
        start,
        end,
        title: '跨集重复字幕（疑似歌词）',
        source: 'subtitle-shared',
        confidence: 0.55,
        fileIndex: i
      })
    }
  }
  return { segments: dedupeLongest(segments.filter((s) => !s.fileIndex || s.fileIndex === 0)), hints: [] }
}

function normalizeLine(s) {
  return String(s || '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,!?;:'"，。！？；：…—～~、]/g, '')
    .trim()
}

function dedupeLongest(list) {
  const best = new Map()
  for (const s of list) {
    const cur = best.get(s.type)
    if (!cur || s.end - s.start > cur.end - cur.start) best.set(s.type, s)
  }
  return [...best.values()].sort((a, b) => a.start - b.start)
}

function fmt(s) {
  const t = Math.max(0, Math.round(Number(s) || 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
