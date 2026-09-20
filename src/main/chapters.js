/**
 * 章节（视频文件打标）→ OP/ED 分段。
 *
 * 番剧容器（MKV/MP4）常带章节：
 *   1) 明确命名：`OP` / `NCOP` / `Opening` / `ED` / `NCED` / `Ending` / `Intro` / `Preview`（BDRip 常见）
 *   2) 通用命名：`Chapter 01..05`——此时靠结构推断：OP/ED 通常是 60~130s 的独立章节，
 *      OP 在靠前位置（含冷开场后的「OP 在中间」），ED 在靠后位置，最后一个小章节多为预告。
 *
 * 实测样本：
 *   - 章节名明确写 `OP`：直接命中（OP 139.10→230.02）
 *   - 冷开场后才有 OP：只有 Intro/Part A/Part B/ED/Preview，OP 藏在 Intro 内（需手动/字幕/音频兜底）
 *   - 通用章节名 `Chapter 01..05`：靠 91s/90s 结构推断出 OP 0→91、ED 1322→1412
 *   - 无章节名：靠结构推断出冷开场后的 OP 105→195
 */

const OP_RE = /^(ncop|op\d*|opening|オープニング|片头曲|片头)$/
const ED_RE = /^(nced|ed\d*|ending|エンディング|片尾曲|片尾)$/
const PREVIEW_RE = /(次回|予告|preview|next)/
const RECAP_RE = /(前情|recap|総集|総集編|总集|まとめ)/
const INTRO_RE = /^(intro|アバン|アバンタイトル|冷开场)$/

/** 章节名 → 语义类型（'' 表示无信息） */
export function classifyChapterName(raw) {
  const n = String(raw || '').trim()
  if (!n) return ''
  const s = n.toLowerCase().replace(/[\s._\-[\]()（）【】:：]/g, '')
  if (!s) return ''
  if (ED_RE.test(s)) return 'ed'
  if (OP_RE.test(s)) return 'op'
  if (PREVIEW_RE.test(s)) return 'preview'
  if (RECAP_RE.test(s)) return 'recap'
  if (INTRO_RE.test(s)) return 'intro'
  return ''
}

const MIN_LEN = 50 // 独立 OP/ED 章节的最短时长
const MAX_LEN = 140 // 最长时长（含少量偏差）
const IDEAL = 90 // 番剧 OP/ED 的典型时长

/**
 * 由章节列表推出分段。
 * @returns {{segments:Array, candidates:Array, hints:string[]}}
 */
export function segmentsFromChapters(chapters, duration) {
  const list = (chapters || []).filter((c) => c && c.end > c.start)
  const dur = Number(duration) > 0 ? Number(duration) : list.length ? list[list.length - 1].end : 0
  const segments = []
  const candidates = []
  const hints = []

  for (const c of list) {
    const type = classifyChapterName(c.title)
    const len = c.end - c.start
    if (type === 'op' || type === 'ed') {
      segments.push({ type, start: c.start, end: c.end, title: c.title, source: 'chapter', confidence: 0.95 })
    } else if (type === 'preview' || type === 'recap') {
      segments.push({ type, start: c.start, end: c.end, title: c.title, source: 'chapter', confidence: 0.9 })
    } else if (type === 'intro') {
      // Intro 只是冷开场，不是 OP；但如果它特别长（>150s），OP 很可能被并进去了
      if (len > 150) hints.push(`章节「${c.title || 'Intro'}」长达 ${Math.round(len)}s，OP 可能被并入其中，自动检测不到时请手动标记`)
    }
  }

  const has = (t) => segments.some((s) => s.type === t)
  const overlaps = (c, t) => segments.some((s) => s.type === t && c.start < s.end && c.end > s.start)

  // 只考虑「像 OP/ED 的独立章节」
  const sized = list.filter((c) => c.end - c.start >= MIN_LEN && c.end - c.start <= MAX_LEN)

  // --- OP 推断：靠前（前 35% 或 600s 以内）---
  if (!has('op') && dur > 0) {
    const headLimit = Math.min(600, dur * 0.35)
    const cands = sized
      .filter((c) => c.start <= headLimit && !overlaps(c, 'op') && !overlaps(c, 'ed'))
      .sort((a, b) => Math.abs(a.end - a.start - IDEAL) - Math.abs(b.end - b.start - IDEAL) || a.start - b.start)
    for (const c of cands) candidates.push({ type: 'op', start: c.start, end: c.end, title: c.title, source: 'chapter-heuristic' })
    if (cands.length) {
      const pick = cands[0]
      segments.push({
        type: 'op',
        start: pick.start,
        end: pick.end,
        title: pick.title,
        source: 'chapter-heuristic',
        confidence: cands.length === 1 ? 0.65 : 0.55,
        ambiguous: cands.length > 1
      })
      if (cands.length > 1) hints.push(`章节结构里有 ${cands.length} 个候选 OP 段，自动选中 ${fmt(pick.start)}–${fmt(pick.end)}，可在播放器里手动改正`)
    }
  }

  // --- ED 推断：靠后（后 28%）---
  if (!has('ed') && dur > 0) {
    const tailFrom = dur * 0.72
    const cands = sized
      .filter((c) => c.start >= tailFrom && !overlaps(c, 'ed'))
      .sort((a, b) => Math.abs(a.end - a.start - IDEAL) - Math.abs(b.end - b.start - IDEAL) || b.start - a.start)
    for (const c of cands) candidates.push({ type: 'ed', start: c.start, end: c.end, title: c.title, source: 'chapter-heuristic' })
    if (cands.length) {
      const pick = cands[0]
      segments.push({
        type: 'ed',
        start: pick.start,
        end: pick.end,
        title: pick.title,
        source: 'chapter-heuristic',
        confidence: cands.length === 1 ? 0.7 : 0.6,
        ambiguous: cands.length > 1
      })
      if (cands.length > 1) hints.push(`章节结构里有 ${cands.length} 个候选 ED 段，自动选中 ${fmt(pick.start)}–${fmt(pick.end)}，可在播放器里手动改正`)
    }
  }

  return { segments, candidates, hints }
}

function fmt(s) {
  const t = Math.max(0, Math.round(Number(s) || 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
