import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadConfig } from './config.js'

/**
 * 全局字幕字体（给渲染层的 libass 用）。
 *
 * 为什么需要它：浏览器里的 libass 看不到系统字体，ASS 中写的字体名（字幕组普遍指定
 * 「方正准圆_GBK」这类圆角中文字体）一个都匹配不上，只能落到 fallbackFont。所以由主进程
 * 挑字体文件、经本地服务喂给 libass，并把 ASS 里的族名映射到具体文件。
 *
 * 字体来源优先级：
 *   1) 设置页手动指定 / 环境变量 PANBOX_SUBTITLE_FONT
 *   2) 随包内置的字幕组字体 resources/vendor/fonts（来源见 README「字体来源声明」）
 *   3) 系统字体：方正准圆 → 方正兰亭圆 → 华文圆体 → 幼圆（Windows 自带圆体）
 *   4) 都没有 → 全局兜底字体（微软雅黑），保证任何机器都能渲染字幕
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 随包内置的字幕组字体（来源见 README）
const PACK_DIR = path.join(__dirname, '../../resources/vendor/fonts')

const FONT_DIRS = [
  PACK_DIR, // 内置优先
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Windows/Fonts'),
  'C:/Windows/Fonts'
]

// 字幕组常用圆角中文字体（按优先级）；keys 用文件名小写包含匹配
const ROUNDED = [
  { family: '方正准圆_GBK', keys: ['方正准圆', 'fzzy', 'fzzhunyuan'] },
  { family: '方正兰亭圆', keys: ['方正兰亭圆', 'fzltyuan'] },
  { family: '华文圆体', keys: ['styuanti', '华文圆体'] },
  { family: '幼圆', keys: ['simyou', 'youyuan', '幼圆'] }
]

/**
 * 「ASS 里的族名 → 具体字体文件」：按文件名包含匹配。命中就把该族名指到对应文件，
 * 做到这一集用到的几个字体各归各位，而不是一律顶替成同一份圆体。
 * 没内置/没装的族名会被略过，最终由 fallbackFont（完整字库）兜底。
 */
const FAMILY_ALIASES = [
  { names: ['方正准圆_gbk', '方正准圆', '方正准圆简体', '方正准圆繁体'], keys: ['方正准圆'] },
  { names: ['方正少儿_gbk', '方正少儿', '方正少儿简体'], keys: ['方正少儿'] },
  { names: ['方正超粗黑_gbk', '方正超粗黑'], keys: ['方正超粗黑'] },
  { names: ['方正毡笔黑简体', '方正毡笔黑'], keys: ['方正毡笔黑'] },
  { names: ['a-otf takahand std b', 'a-otf takahand std', 'a-otf takahand std b_1'], keys: ['takahandstd'] },
  { names: ['tt-jtcナミキ中太楷書', 'tt-jtcナミキ中太楷书', 'tt-jtcナミキ特太楷書'], keys: ['ナミキ'] },
  { names: ['张海山草泥马体'], keys: ['张海山'] },
  { names: ['方正兰亭圆', '方正兰亭圆_gbk', 'fzltyuan'], keys: ['方正兰亭圆'] }
]

// 全局兜底字体（系统里没有任何圆体时使用）
const GLOBAL_FALLBACK = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  'C:/Windows/Fonts/deng.ttf'
]

// 完整字库（缺字回退 + 「微软雅黑」族名）
const WIDE = ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyhbd.ttc']

// libass 的 availableFonts 以「族名小写」为键，这里登记通用写法
const ROUNDED_NAMES = [
  '方正准圆_gbk', '方正准圆', '方正准圆简繁', 'fzjunyuan', 'fzjunyuan-gbk',
  '华文圆体', 'styuanti', '幼圆', 'youyuan', 'simyou'
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
      continue
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

function exists(p) {
  try {
    return !!p && fs.existsSync(p)
  } catch {
    return false
  }
}

function baseName(p) {
  const b = path.basename(String(p || ''))
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(0, i) : b
}

/** 找一个圆角中文字体：内置优先，其次系统；没有返回 null */
function findRounded() {
  const files = listFonts()
  for (const cand of ROUNDED) {
    const hit = files.find((f) => cand.keys.some((k) => f.low.includes(k)))
    if (hit) {
      return {
        family: cand.family,
        file: path.join(hit.dir, hit.name),
        source: hit.dir === PACK_DIR ? 'pack' : 'system'
      }
    }
  }
  return null
}

/**
 * 手动指定字体文件（优先级最高）：
 *   1) 设置页「全局字幕字体 → 选择字体文件…」（config.json 的 subtitleFontPath）
 *   2) 环境变量 PANBOX_SUBTITLE_FONT=/path/to/方正兰亭圆.ttf
 */
function overrideFont() {
  try {
    const p = loadConfig().subtitleFontPath
    if (exists(p)) return p
  } catch {
    /* ignore */
  }
  return exists(process.env.PANBOX_SUBTITLE_FONT) ? process.env.PANBOX_SUBTITLE_FONT : null
}

/* ---- 字体指纹：字体文件换了 URL 也换，免得浏览器拿 max-age 缓存里的旧字体 ---- */
const tokenFile = new Map()

function tokenOf(file) {
  try {
    const st = fs.statSync(file)
    return path.basename(file) + '-' + st.size + '-' + Math.round(st.mtimeMs)
  } catch {
    return path.basename(file)
  }
}

function register(file) {
  const t = tokenOf(file)
  if (!tokenFile.has(t)) tokenFile.set(t, file)
  return t
}

/** token → 字体文件（供 /vendor/fonts/f 白名单取用，不接受任意路径） */
export function fileByToken(token) {
  return tokenFile.get(String(token || '')) || null
}

/** /vendor/fonts/cjk 要发的文件：手动指定 > 圆体优先（内置→系统）> 全局兜底 */
export function primaryFontFile() {
  const forced = overrideFont()
  if (forced) return forced
  const r = findRounded()
  return r ? r.file : firstExisting(GLOBAL_FALLBACK)
}

/** /vendor/fonts/yahei 要发的文件（完整字库） */
export function wideFontFile() {
  return firstExisting(WIDE)
}

/** ASS 族名 → 具体字体文件（命中内置/系统字体的那些） */
function familyBuckets() {
  const files = listFonts()
  const out = []
  for (const a of FAMILY_ALIASES) {
    const hit = files.find((f) => a.keys.some((k) => f.low.includes(k)))
    if (!hit) continue
    out.push({ names: a.names, token: register(path.join(hit.dir, hit.name)), pack: hit.dir === PACK_DIR })
  }
  return out
}

/** 给 /api/status 的字体信息：渲染层据此拼 libass 的 availableFonts / fallbackFont */
export function subtitleFontInfo() {
  const forced = overrideFont()
  const rounded = findRounded()
  let family = ''
  let source = 'fallback'
  if (forced) {
    family = baseName(forced)
    source = 'manual'
  } else if (rounded) {
    family = baseName(rounded.file)
    source = rounded.source
  } else {
    const f = firstExisting(GLOBAL_FALLBACK)
    family = f ? baseName(f) : ''
    source = 'fallback'
  }
  const wide = wideFontFile()
  return {
    requested: ROUNDED[0].family, // 想用的字幕组常用圆体
    family: family || '(no font found)',
    source, // manual | pack | system | fallback
    installed: !!(rounded && rounded.source === 'system'),
    fallback: source === 'fallback',
    forced: !!forced,
    roundedNames: ROUNDED_NAMES,
    wideNames: wide ? WIDE_NAMES : [],
    families: familyBuckets(),
    token: register(primaryFontFile()),
    wideToken: wide ? register(wide) : ''
  }
}
