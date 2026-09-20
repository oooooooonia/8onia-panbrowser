import fs from 'fs'
import path from 'path'

/**
 * 全局字幕字体（给渲染层的 libass 用）。
 *
 * 为什么需要它：浏览器里的 libass 看不到系统字体，ASS 中写的字体名（字幕组发布普遍指定
 * 「方正准圆_GBK」这类圆角中文字体）一个都匹配不上，只能落到 fallbackFont，于是原意是圆体的
 * 字幕被渲染成默认黑体。所以由主进程在系统里挑一份合适的字体文件，经本地服务喂给 libass，
 * 并把常见字体名映射到它。
 *
 * 优先级：方正准圆（用户自己装了就有，与字幕组原意一致）→ 方正兰亭圆 → 华文圆体 → 幼圆
 *        （Windows 自带圆体）→ 都没有则用「全局字体」兜底（微软雅黑）。
 * 另外 /vendor/fonts/yahei 提供一份完整字库，作为缺字回退与「微软雅黑」族名的映射。
 */

// 搜索目录：用户级在前（同名可覆盖系统级）
const FONT_DIRS = [
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Windows/Fonts'),
  'C:/Windows/Fonts'
]

// 字幕组常用圆角中文字体（按优先级）；keys 用文件名小写包含匹配
const ROUNDED = [
  { family: '方正准圆_GBK', keys: ['fzjunyuan', '方正准圆', 'fzy3jw'] },
  { family: '方正兰亭圆', keys: ['fzltyuan', '方正兰亭圆'] },
  { family: '华文圆体', keys: ['styuanti', '华文圆体'] },
  { family: '幼圆', keys: ['simyou', 'youyuan', '幼圆'] }
]

// 全局兜底字体（系统里没有任何圆体时使用）：黑体/雅黑，字形覆盖全，保证不会整段缺字
const GLOBAL_FALLBACK = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  'C:/Windows/Fonts/deng.ttf'
]

// 完整字库（缺字回退 + 「微软雅黑」族名）
const WIDE = ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyhbd.ttc']

// libass 的 availableFonts 以「字体名小写」为键，这里把常见写法都登记上
const ROUNDED_NAMES = [
  '方正准圆_gbk', '方正准圆', '方正准圆简繁', 'fzjunyuan', 'fzjunyuan-gbk',
  '方正兰亭圆', 'fzltyuan', '华文圆体', 'styuanti', '幼圆', 'youyuan', 'simyou'
]
const WIDE_NAMES = ['微软雅黑', 'microsoft yahei', 'microsoftyahei', 'msyh', '雅黑']

const FONT_EXTS = ['.ttf', '.otf', '.ttc']

let dirCache = null

function listFonts() {
  if (dirCache) return dirCache
  const out = []
  for (const dir of FONT_DIRS) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue // 目录不存在（比如没有用户级字体）
    }
    for (const name of names) {
      const low = name.toLowerCase()
      if (!FONT_EXTS.some((e) => low.endsWith(e))) continue
      out.push({ name, low, dir })
    }
  }
  dirCache = out
  return out
}

function firstExisting(list) {
  for (const f of list) {
    try {
      if (fs.existsSync(f)) return f
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 找一个字幕组常用圆角中文字体；没有返回 null */
function findRounded() {
  const files = listFonts()
  for (const cand of ROUNDED) {
    const hit = files.find((f) => cand.keys.some((k) => f.low.includes(k)))
    if (hit) return { family: cand.family, file: path.join(hit.dir, hit.name) }
  }
  return null
}

/**
 * 手动指定字体文件（可选，优先级最高）：
 * 环境变量 PANBOX_SUBTITLE_FONT=/path/to/方正准圆_GBK.ttf
 * —— 自己有一份方正准圆（字幕组字体包里的）时最省事，也可用来排查字体问题。
 */
function envOverride() {
  const p = process.env.PANBOX_SUBTITLE_FONT
  if (!p) return null
  try {
    return fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}

/** /vendor/fonts/cjk 要发的文件：手动指定 > 圆体优先 > 全局兜底字体 */
export function primaryFontFile() {
  const forced = envOverride()
  if (forced) return forced
  const r = findRounded()
  return r ? r.file : firstExisting(GLOBAL_FALLBACK)
}

/** /vendor/fonts/yahei 要发的文件（完整字库，用作缺字回退）；没有返回 null */
export function wideFontFile() {
  return firstExisting(WIDE)
}

/** 给 /api/status 的字体信息：前端据此构造 libass 的 availableFonts / fallbackFont */
export function subtitleFontInfo() {
  const forced = envOverride()
  const rounded = findRounded()
  const wanted = ROUNDED[0].family
  let family = forced ? path.basename(forced) : rounded ? rounded.family : ''
  let installed = !!(rounded && family === wanted)
  let isFallback = false
  if (forced) return finish(family, false, false, true)
  if (!rounded) {
    // 系统里没有任何圆体 → 用全局字体渲染（不是圆体，但保证有字形）
    const f = firstExisting(GLOBAL_FALLBACK)
    family = f ? path.basename(f) : ''
    installed = false
    isFallback = true
  }
  return finish(family, installed, isFallback, false)
}

function finish(family, installed, isFallback, forced) {
  const wide = wideFontFile()
  return {
    requested: ROUNDED[0].family, // 想用的字幕组常用圆体
    family: family || '(no font found)',
    installed, // requested 是否真的装在系统里
    fallback: isFallback, // 是否退到了全局兜底字体
    forced: !!forced, // 是否由 PANBOX_SUBTITLE_FONT 手动指定
    roundedNames: ROUNDED_NAMES,
    wideNames: wide ? WIDE_NAMES : [],
    // 字体文件的「指纹」：字体一换 URL 就变，否则浏览器会拿 max-age 缓存里的旧字体
    token: fontToken(primaryFontFile()),
    wideToken: wide ? fontToken(wide) : ''
  }
}

function fontToken(file) {
  if (!file) return ''
  try {
    const st = fs.statSync(file)
    return path.basename(file) + '-' + st.size + '-' + Math.round(st.mtimeMs)
  } catch {
    return path.basename(file)
  }
}
