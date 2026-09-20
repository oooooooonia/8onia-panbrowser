/** 单元自测：用真实样本验证 chapters.js / subsig.js 的判定逻辑（不依赖 Electron）
 *  用法: node pan-browser/_probe/skip_unit_test.mjs [assPath]
 */
import fs from 'fs'
import { classifyChapterName, segmentsFromChapters } from '../src/main/chapters.js'
import { analyzeAss, parseSrt, analyzeSharedText } from '../src/main/subsig.js'

let pass = 0
let fail = 0
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`)
}
function near(label, got, want, tol = 0.6) {
  const ok = Math.abs(got - want) <= tol
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` (got ${got}, want ~${want})`}`)
}

/* ---------- 1) 章节名分类 ---------- */
console.log('\n== 章节名分类 ==')
for (const [name, want] of [
  ['OP', 'op'], ['NCOP', 'op'], ['Opening', 'op'], ['オープニング', 'op'], ['片头曲', 'op'],
  ['ED', 'ed'], ['NCED', 'ed'], ['Ending', 'ed'], ['エンディング', 'ed'],
  ['Preview', 'preview'], ['次回予告', 'preview'], ['前情提要', 'recap'],
  ['Intro', 'intro'], ['Chapter 01', ''], ['Part A', ''], ['Chapter 6', '']
]) {
  eq(`classify(${JSON.stringify(name)})`, classifyChapterName(name), want)
}

/* ---------- 2) 真实章节结构 → 分段 ---------- */
console.log('\n== 章节结构推断 ==')
// 样本 A：通用 Chapter 01..05（0-91 是 OP，1322-1412 是 ED）
const sampleA = [
  { start: 0, end: 91.008, title: 'Chapter 01' },
  { start: 91.008, end: 705.496, title: 'Chapter 02' },
  { start: 705.496, end: 1322.446, title: 'Chapter 03' },
  { start: 1322.446, end: 1412.453, title: 'Chapter 04' },
  { start: 1412.453, end: 1423.59, title: 'Chapter 05' }
]
const ra = segmentsFromChapters(sampleA, 1423.6)
const aOp = ra.segments.find((s) => s.type === 'op')
const aEd = ra.segments.find((s) => s.type === 'ed')
eq('样本A OP 起点', Math.round(aOp.start), 0)
near('样本A OP 终点', aOp.end, 91.008)
near('样本A ED 起点', aEd.start, 1322.446)
near('样本A ED 终点', aEd.end, 1412.453)

// 样本 B：冷开场后才是 OP（105-195）
const sampleB = [
  { start: 0, end: 105.02, title: 'Chapter 01' },
  { start: 105.02, end: 194.99, title: 'Chapter 02' },
  { start: 194.99, end: 600.98, title: 'Chapter 03' },
  { start: 600.98, end: 1330.0, title: 'Chapter 04' },
  { start: 1330.0, end: 1420.0, title: 'Chapter 05' },
  { start: 1420.0, end: 1454.12, title: 'Chapter 06' }
]
const rb = segmentsFromChapters(sampleB, 1454.12)
const bOp = rb.segments.find((s) => s.type === 'op')
const bEd = rb.segments.find((s) => s.type === 'ed')
near('样本B OP 起点（冷开场后）', bOp.start, 105.02)
near('样本B OP 终点', bOp.end, 194.99)
near('样本B ED 起点', bEd.start, 1330.0)

// 样本 C：章节直接标注 OP/ED/Preview
const sampleC = [
  { start: 0, end: 139.1, title: 'Intro' },
  { start: 139.1, end: 230.02, title: 'OP' },
  { start: 230.02, end: 873.0, title: 'Part A' },
  { start: 873.0, end: 1323.95, title: 'Part B' },
  { start: 1323.95, end: 1416.0, title: 'ED' },
  { start: 1416.0, end: 1421.0, title: 'Preview' },
  { start: 1421.0, end: 1422.03, title: 'Chapter 07' }
]
const rc = segmentsFromChapters(sampleC, 1422.03)
eq('样本C 标注 OP 区间', [rc.segments.find((s) => s.type === 'op').start, rc.segments.find((s) => s.type === 'op').end], [139.1, 230.02])
eq('样本C 标注 OP 置信度', rc.segments.find((s) => s.type === 'op').confidence, 0.95)
eq('样本C 有 Preview', rc.segments.some((s) => s.type === 'preview'), true)

// 样本 D：Intro 很长、无 OP 章节 → 应报 hint 且不给 OP
const sampleD = [
  { start: 0, end: 213.0, title: 'Intro' },
  { start: 213.0, end: 515.97, title: 'Part A' },
  { start: 515.97, end: 1324.78, title: 'Part B' },
  { start: 1324.78, end: 1415.91, title: 'ED' },
  { start: 1415.91, end: 1420.92, title: 'Preview' },
  { start: 1420.92, end: 1422.07, title: 'Chapter 06' }
]
const rd = segmentsFromChapters(sampleD, 1422.07)
eq('样本D 不误报 OP', rd.segments.some((s) => s.type === 'op'), false)
eq('样本D 有 Intro 提示', rd.hints.some((h) => h.includes('Intro')), true)
near('样本D ED 起点', rd.segments.find((s) => s.type === 'ed').start, 1324.78)

/* ---------- 3) 真实 ASS 样式名 → 歌词块（番剧内嵌 CHS 轨） ---------- */
const assPath = process.argv[2] || `${process.env.TEMP}\\ep01_chs.ass`
console.log('\n== ASS 字幕信号 ==', assPath)
if (fs.existsSync(assPath)) {
  const text = fs.readFileSync(assPath, 'utf-8')
  const r = analyzeAss(text, { duration: 1423.6 })
  console.log(`   分段数=${r.segments.length} 提示=${JSON.stringify(r.hints)}`)
  const ed = r.segments.find((s) => s.type === 'ed')
  if (ed) {
    near('ASS 歌词块 → ED 起点', ed.start, 1322.9, 2)
    near('ASS 歌词块 → ED 终点', ed.end, 1409.8, 2)
    eq('ASS 歌词块置信度（样式名与位置不符，降为 0.6）', ed.confidence, 0.6)
  } else {
    fail++
    console.log('FAIL  ASS 未识别出歌词块')
  }
  eq('样式名误用提示存在', r.hints.some((h) => h.includes('OPCN') || h.includes('OPJP')), true)
} else {
  console.log('   (跳过：未找到 ASS 样本)')
}

/* ---------- 4) SRT 解析 + 跨集共享文本 ---------- */
console.log('\n== SRT 解析 / 跨集重复文本 ==')
const srtA = '1\n00:01:07,080 --> 00:01:09,340\n那么 是什么颜色呢\n\n2\n00:01:10,090 --> 00:01:11,330\n是漂亮的粉色\n'
const srtB = '1\n00:00:10,000 --> 00:00:11,000\n那么 是什么颜色呢\n\n2\n00:00:12,000 --> 00:00:13,000\n是漂亮的粉色\n'
const evA = parseSrt(srtA)
eq('SRT 事件数', evA.length, 2)
near('SRT 首条起点', evA[0].start, 67.08, 0.01)
const shared = analyzeSharedText([{ events: parseSrt(srtB), offset: 0 }, { events: evA, offset: 0 }], { duration: 1422, minFiles: 2 })
eq('跨集共享块（2 行 <5 条，不应成块）', shared.segments.length, 0)

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
