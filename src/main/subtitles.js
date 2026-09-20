/** 字幕转换：把百度网盘里的常见外挂字幕统一转成带样式的 ASS（喂给 libass/SubtitlesOctopus 渲染）或 WebVTT。
 *  支持格式：SRT(.srt) / ASS(.ass) / SSA(.ssa) / WebVTT(.vtt) / SubViewer 与 MicroDVD(.sub) / YouTube(.sbv)。
 *  对所有“纯文本”格式统一转成增强 ASS（白字、细黑描边+轻阴影、底部居中），观感对齐 PotPlayer。
 */

export const SUB_EXTS = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.sbv']
export const isSubtitleName = (name) => SUB_EXTS.includes(extOf(name))
export const extOf = (name) => {
  const i = String(name).lastIndexOf('.')
  return i >= 0 ? String(name).slice(i).toLowerCase() : ''
}

export function decodeSubtitle(buf) {
  if (!buf || !buf.length) return ''
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2)
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2)
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]
      swapped[i - 1] = buf[i]
    }
    return swapped.toString('utf16le')
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3)
  return buf.toString('utf8')
}

function tsToVtt(ts) {
  // 兼容 hh:mm:ss,mmm | h:mm:ss.cc | hh:mm:ss.mmm
  const m = /(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(ts.trim())
  if (!m) return null
  const hh = String(Number(m[1])).padStart(2, '0')
  const mm = String(Number(m[2])).padStart(2, '0')
  const ss = String(Number(m[3])).padStart(2, '0')
  const ms = String(m[4]).padEnd(3, '0').slice(0, 3)
  return `${hh}:${mm}:${ss}.${ms}`
}

const TAG_RE = /\{\\[^}]*\}|\{[^}]*\}/g
function cleanAssText(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(TAG_RE, '')
    .replace(/<[^>]*>/g, '')
    .trim()
}

/** 文本行清洗：只保留 WebVTT 认识的内联标签(b/i/u/ruby…)，剥掉 font 等其余 HTML / 声道标记 */
function cleanSrtText(text) {
  return String(text).replace(/<\/?([a-zA-Z0-9]+)[^>]*>/g, (m, tag) => {
    return /^(b|i|u|ruby|rt|rp)$/i.test(tag) ? m : ''
  })
}

/** 秒 -> HH:MM:SS.mmm */
function secsToTs(sec) {
  const total = Math.max(0, Number(sec) || 0)
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = Math.floor(total % 60) % 60
  const ms = Math.floor((total * 1000) % 1000)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** 解析 SRT 得到 cues：{s:'HH:MM:SS.mmm', e, text(已清洗)} */
export function parseSrtCues(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const cues = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    // 纯数字编号行：跳过，继续下一行
    if (/^\d+$/.test(line)) {
      i++
      continue
    }
    const tm = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/.exec(line)
    if (!tm) {
      i++
      continue
    }
    i++
    const buf = []
    while (i < lines.length && lines[i].trim() !== '') {
      buf.push(lines[i])
      i++
    }
    const s = tsToVtt(tm[1])
    const e = tsToVtt(tm[2])
    if (s && e) cues.push({ s, e, text: cleanSrtText(buf.join('\n')).trim() })
  }
  return cues
}

/** 解析 WebVTT 得到 cues（允许可选 cue id 行 + 时间戳行后的 cue settings） */
export function parseVttCues(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const cues = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (!line) {
      i++
      continue
    }
    const tm = /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})/.exec(line)
    if (!tm) {
      i++
      continue
    }
    i++
    const buf = []
    while (i < lines.length && lines[i].trim() !== '') {
      buf.push(lines[i])
      i++
    }
    const s = tsToVtt(tm[1])
    const e = tsToVtt(tm[2])
    if (s && e) cues.push({ s, e, text: cleanSrtText(buf.join('\n')).trim() })
  }
  return cues
}

/** 解析 SubViewer / YouTube `.sbv`：行格式 `HH:MM:SS.cc,HH:MM:SS.cc` 后跟文本行 */
function parseSubViewerCues(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const cues = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    const tm = /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*,\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})/.exec(line)
    if (!tm) {
      i++
      continue
    }
    i++
    const buf = []
    while (i < lines.length && lines[i].trim() !== '') {
      buf.push(lines[i])
      i++
    }
    const s = tsToVtt(tm[1])
    const e = tsToVtt(tm[2])
    if (s && e) cues.push({ s, e, text: cleanSrtText(buf.join('\n')).trim() })
  }
  return cues
}

/** 解析 MicroDVD `.sub`：行格式 `{startFrame}{endFrame}text`，需要 FPS 换算成时间 */
function parseMicroDvdCues(text) {
  let fps = 25
  // 常见头部 `{1}{1}25.000` 写入 FPS；也可 `{1}{1}23.976`
  const fpsM = /\{(\d+)\}\{(\d+)\}\s*(\d+(?:\.\d+)?)(?:\s|$)/.exec(String(text).slice(0, 200))
  if (fpsM) fps = Number(fpsM[3]) || 25
  const cues = []
  for (const rawLine of String(text).replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim()
    const m = /\{(\d+)\}\{(\d+)\}(.*)$/.exec(line)
    if (!m) continue
    const sFrame = Number(m[1])
    const eFrame = Number(m[2])
    const body = m[3].replace(/\|/g, '\n')
    const s = secsToTs(sFrame / fps)
    const e = secsToTs(eFrame / fps)
    const txt = cleanAssText(body).trim()
    if (s && e && txt) cues.push({ s, e, text: txt })
  }
  return cues
}

/** SRT -> VTT 文本 */
export function srtToVtt(text) {
  const cues = parseSrtCues(text)
  if (!cues.length) return ''
  return `WEBVTT\n\n${cues.map((c) => `${c.s} --> ${c.e}\n${c.text}`).join('\n\n')}\n`
}

/** VTT 时间戳(HH:MM:SS.mmm) -> ASS 时间(HH:MM:SS.cc) */
function vttTsToAss(ts) {
  const m = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(String(ts).trim())
  if (!m) return ts
  const cs = String(Math.floor(Number(m[4]) / 10)).padStart(2, '0')
  return `${Number(m[1])}:${m[2]}:${m[3]}.${cs}`
}

/**
 * 统一 cue -> 增强 ASS（接近 PotPlayer 默认观感：白字、细黑描边+轻阴影、底部居中、非粗体）。
 * opts: { width, height, fontScale(字号占高比例, 默认0.05), outline, shadow, bold, secondary }
 */
export function cuesToAss(cues, opts = {}) {
  if (!cues || !cues.length) return ''
  const width = opts.width || 1920
  const height = opts.height || 1080
  const fontScale = Math.max(0.015, Number(opts.fontScale) || 0.05)
  const outline = Math.max(0, Number(opts.outline) || 1.4)
  const shadow = Math.max(0, Number(opts.shadow) || 0.6)
  const bold = opts.bold ? 1 : 0
  const size = Math.max(16, Math.round(height * fontScale))
  const marginV = Math.round(height * 0.05)
  const secondary = /^&H[0-9A-Fa-f]{8}$/.test(String(opts.secondary || '')) ? opts.secondary : '&H0000FFFF'
  const lines = []
  lines.push('[Script Info]')
  lines.push('ScriptType: v4.00+')
  lines.push(`PlayResX: ${width}`)
  lines.push(`PlayResY: ${height}`)
  lines.push('ScaledBorderAndShadow: yes')
  lines.push('WrapStyle: 0')
  lines.push('')
  lines.push('[V4+ Styles]')
  lines.push(
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding'
  )
  lines.push(
    `Style: Default,Microsoft YaHei,${size},&H00FFFFFF,${secondary},&H00000000,&H96000000,${bold},0,0,0,100,100,0,0,1,${outline},${shadow},2,40,40,${marginV},1`
  )
  lines.push('')
  lines.push('[Events]')
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')
  for (const c of cues) {
    const text2 = c.text.replace(/\n/g, '\\N') // 多行转 ASS 硬换行
    lines.push(`Dialogue: 0,${vttTsToAss(c.s)},${vttTsToAss(c.e)},Default,,0,0,0,,${text2}`)
  }
  return lines.join('\n') + '\n'
}

/** SRT -> 增强 ASS（统一走 cuesToAss，观感对齐 PotPlayer） */
export function srtToAss(text, opts = {}) {
  return cuesToAss(parseSrtCues(text), opts)
}

/** WebVTT -> 增强 ASS */
export function vttToAss(text, opts = {}) {
  return cuesToAss(parseVttCues(text), opts)
}

/** SubViewer/SBV/MicroDVD -> 增强 ASS */
export function subToAss(text, opts = {}) {
  const inText = String(text)
  const isMicro = /\{\d+\}\{\d+\}/.test(inText.slice(0, 500))
  return isMicro ? cuesToAss(parseMicroDvdCues(inText), opts) : cuesToAss(parseSubViewerCues(inText), opts)
}

/** ASS/SSA -> VTT 文本（取文字，忽略特效样式与定位） */
export function assToVtt(text) {
  const raw = String(text).replace(/\r/g, '')
  const fmtMatch = /\[Events\][\s\S]*?Format:\s*([^\n]+)/i.exec(raw)
  if (!fmtMatch) return ''
  const fields = fmtMatch[1].split(',').map((f) => f.trim().toLowerCase())
  const startIdx = fields.indexOf('start')
  const endIdx = fields.indexOf('end')
  const textIdx = fields.indexOf('text')
  if (startIdx < 0 || endIdx < 0 || textIdx < 0) return ''
  const re = /^Dialogue:/i
  const cues = []
  for (const line of raw.split('\n')) {
    const l = line.trim()
    if (!re.test(l)) continue
    const parts = l.replace(re, '').trim().split(',')
    if (parts.length < textIdx + 1) continue
    const s = tsToVtt(parts[startIdx])
    const e = tsToVtt(parts[endIdx])
    const content = cleanAssText(parts.slice(textIdx).join(','))
    if (s && e && content) cues.push(`${s} --> ${e}\n${content}`)
  }
  if (!cues.length) return ''
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/** VTT 规范化（缺头补头） */
export function vttToVtt(text) {
  let t = String(text).replace(/\r/g, '')
  if (!/^WEBVTT/i.test(t.trim())) t = `WEBVTT\n\n${t.trimStart()}`
  return t
}

/**
 * 内容嗅探（扩展名经常与内容不符）：返回真实格式 ass | srt | vtt | subviewer | microdvd。
 * ext 仅作兜底。
 */
export function detectSubtitleType(text, ext = '') {
  const sample = String(text).slice(0, 6000)
  // MicroDVD：{帧数}{帧数}
  if (/\{\d+\}\{\d+\}/.test(sample)) return 'microdvd'
  if (/\[Script Info\]/i.test(sample) || /^Dialogue:/m.test(sample)) return 'ass'
  // SubViewer / SBV：`HH:MM:SS.cc,HH:MM:SS.cc`（逗号分隔，无 -->）
  if (!/-->/.test(sample) && /^\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*,\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/m.test(sample)) return 'subviewer'
  // WebVTT：头部 WEBVTT，或 `-->` 且时间戳为点毫秒
  if (/WEBVTT/i.test(sample) || /^\s*\d{1,2}:\d{2}:\d{2}\.\d{3}\s*-->/m.test(sample)) return 'vtt'
  // SRT：编号行后 `-->`（逗号或点毫秒均可）
  if (/^\s*\d+\s*[\r\n]+\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/m.test(sample)) return 'srt'
  switch (ext.toLowerCase()) {
    case '.ass':
    case '.ssa':
      return 'ass'
    case '.sub':
      return 'microdvd'
    case '.vtt':
      return 'vtt'
    case '.sbv':
      return 'subviewer'
    case '.srt':
      return 'srt'
    default:
      return 'srt'
  }
}

/** 解析给定格式文本 -> cues */
export function parseCuesByType(text, type) {
  switch (type) {
    case 'ass':
    case 'ssa':
      return assToVttCues(text)
    case 'vtt':
      return parseVttCues(text)
    case 'subviewer':
      return parseSubViewerCues(text)
    case 'microdvd':
      return parseMicroDvdCues(text)
    case 'srt':
    default:
      return parseSrtCues(text)
  }
}

/** ASS/SSA -> cues（复用 assToVtt 的解析逻辑，返回 cue 数组） */
function assToVttCues(text) {
  const raw = String(text).replace(/\r/g, '')
  const fmtMatch = /\[Events\][\s\S]*?Format:\s*([^\n]+)/i.exec(raw)
  if (!fmtMatch) return []
  const fields = fmtMatch[1].split(',').map((f) => f.trim().toLowerCase())
  const startIdx = fields.indexOf('start')
  const endIdx = fields.indexOf('end')
  const textIdx = fields.indexOf('text')
  if (startIdx < 0 || endIdx < 0 || textIdx < 0) return []
  const re = /^Dialogue:/i
  const cues = []
  for (const line of raw.split('\n')) {
    const l = line.trim()
    if (!re.test(l)) continue
    const parts = l.replace(re, '').trim().split(',')
    if (parts.length < textIdx + 1) continue
    const s = tsToVtt(parts[startIdx])
    const e = tsToVtt(parts[endIdx])
    const content = cleanAssText(parts.slice(textIdx).join(','))
    if (s && e && content) cues.push({ s, e, text: content })
  }
  return cues
}

/** 统一入口：内容优先嗅探真实格式，扩展名仅作兜底；返回 WebVTT 文本 */
export function subtitleToVtt(buf, ext) {
  const text = decodeSubtitle(buf)
  const type = detectSubtitleType(text, ext)
  if (type === 'ass' || type === 'ssa') return assToVtt(text)
  if (type === 'srt') return srtToVtt(text)
  if (type === 'subviewer' || type === 'microdvd') {
    const cues = parseCuesByType(text, type)
    if (!cues.length) return ''
    return `WEBVTT\n\n${cues.map((c) => `${c.s} --> ${c.e}\n${c.text}`).join('\n\n')}\n`
  }
  // vtt 或命名错误但内容为 vtt
  if (ext === '.srt' && /-->/.test(text)) return srtToVtt(text)
  return vttToVtt(text)
}

/**
 * 统一入口：任意文本字幕（文本） -> 增强 ASS（供 libass 渲染出 PotPlayer 观感）。
 * 真 ASS/SSA 原样透传（保留原定位/特效）；其余格式统一增强成白字描边样式。
 * opts: { width, height, fontScale, outline, shadow, bold }
 */
export function subtitleToAss(text, ext, opts = {}) {
  const type = detectSubtitleType(text, ext)
  if (type === 'ass' || type === 'ssa') {
    // 原样返回真 ASS（保留压制组做的定位与特效）
    return String(text)
  }
  return cuesToAss(parseCuesByType(text, type), opts)
}

/**
 * 字幕粗细：libass 只有「合成加粗」一档（FreeType embolden），没有独立字重，
 * 而替代用的圆体（如系统幼圆）往往只有一个偏细的字重，所以：
 *   normal → 原样不动
 *   medium → 把 Bold=0 的样式打开（视觉≈中等粗细）
 *   bold   → 全部打开，并把描边加粗一点（再厚一档）
 * 需要在 [V4+ Styles] 段里按 Format 行定位 Bold / Outline 列，不能写死下标（各家写法不同）。
 */
export function applySubWeight(ass, weight = 'medium') {
  if (!ass || weight === 'normal') return ass
  const out = []
  let inStyles = false
  let boldAt = -1
  let outlineAt = -1
  for (const line of String(ass).split('\n')) {
    const low = line.trim().toLowerCase()
    if (low.startsWith('[')) {
      inStyles = low === '[v4+ styles]' || low === '[v4 styles]'
      boldAt = -1
      outlineAt = -1
      out.push(line)
      continue
    }
    if (!inStyles) {
      out.push(line)
      continue
    }
    if (low.startsWith('format:')) {
      const cols = line.slice(line.indexOf(':') + 1).split(',').map((x) => x.trim().toLowerCase())
      boldAt = cols.indexOf('bold')
      outlineAt = cols.indexOf('outline')
      out.push(line)
      continue
    }
    if (!low.startsWith('style:') || boldAt < 0) {
      out.push(line)
      continue
    }
    const parts = line.split(',')
    if (parts.length > boldAt && (weight === 'bold' || parts[boldAt].trim() === '0')) parts[boldAt] = ' -1'
    if (weight === 'bold' && outlineAt >= 0 && parts.length > outlineAt) {
      const o = Number(parts[outlineAt].trim())
      if (Number.isFinite(o)) parts[outlineAt] = ' ' + (o + 0.8).toFixed(1)
    }
    out.push(parts.join(','))
  }
  return out.join('\n')
}
