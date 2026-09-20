/** 片段搜索：把「疑似 OP 片段」在另一集里找出来（验证跨集音频定位 OP 是否可行）
 *  用法: node op_pattern_search.mjs <pattern.raw> <patStartSec> <patEndSec> <target.raw>
 */
import fs from 'fs'
const SR = 8000, FRAME = 800, NFFT = 512, NBAND = 16

function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr; im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr
      }
    }
  }
}
const bandEdges = []
for (let i = 0; i <= NBAND; i++) bandEdges.push(Math.round((40 * Math.pow(3800 / 40, i / NBAND)) / (SR / NFFT)))

function framesOf(buf, fromF, toF) {
  const out = []
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT)
  for (let f = fromF; f < toF; f++) {
    const off = f * FRAME * 2
    if (off + NFFT * 2 > buf.length) break
    let energy = 0
    for (let i = 0; i < NFFT; i++) {
      const s = buf.readInt16LE(off + i * 2) / 32768
      energy += s * s
      re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NFFT - 1)))
      im[i] = 0
    }
    if (energy / NFFT < 1e-6) { out.push(null); continue }
    fft(re, im)
    const mag = new Float64Array(NBAND)
    for (let b = 0; b < NBAND; b++) {
      let s = 0
      for (let k = bandEdges[b]; k < bandEdges[b + 1]; k++) s += Math.hypot(re[k], im[k])
      mag[b] = Math.log1p(s)
    }
    let norm = 0
    for (let b = 0; b < NBAND; b++) norm += mag[b] * mag[b]
    norm = Math.sqrt(norm) || 1
    for (let b = 0; b < NBAND; b++) mag[b] /= norm
    out.push(mag)
  }
  return out
}

const [, , patFile, s0, s1, tgtFile] = process.argv
const pb = fs.readFileSync(patFile)
const tb = fs.readFileSync(tgtFile)
const P = framesOf(pb, Math.round(+s0 * 10), Math.round(+s1 * 10))
const T = framesOf(tb, 0, Math.floor(tb.length / 2 / FRAME))
console.log(`pattern frames=${P.length} (${(P.length / 10).toFixed(1)}s)  target frames=${T.length} (${(T.length / 10).toFixed(1)}s)`)

const res = []
for (let off = 0; off + P.length <= T.length; off++) {
  let sum = 0, cnt = 0
  for (let i = 0; i < P.length; i++) {
    if (!P[i] || !T[off + i]) continue
    let d = 0
    for (let k = 0; k < NBAND; k++) d += P[i][k] * T[off + i][k]
    sum += d; cnt++
  }
  if (cnt > P.length * 0.5) res.push({ off, score: sum / cnt })
}
res.sort((a, b) => b.score - a.score)
console.log('top matches (offset in target → pattern position):')
for (const r of res.slice(0, 8)) {
  console.log(`  target ${(r.off / 10).toFixed(1)}s .. ${((r.off + P.length) / 10).toFixed(1)}s   score=${r.score.toFixed(3)}`)
}
