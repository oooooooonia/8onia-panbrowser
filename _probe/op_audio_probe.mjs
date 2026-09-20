/**
 * 原型验证：跨集音频指纹比对定位 OP/ED（Plex 式 intro detection 的简化版）
 * 输入：两个 8kHz mono s16le PCM 文件（ffmpeg 解码前 N 秒音频得到）
 * 输出：最佳时间偏移 + 共享音频块（= OP/ED）在各自时间轴上的区间
 */
import fs from 'fs'

const SR = 8000
const FRAME = 800 // 100ms → 10fps
const NFFT = 512
const NBAND = 16

function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr; im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr; cr = ncr
      }
    }
  }
}

/** log-spaced band edges over 0..SR/2 */
const bandEdges = []
for (let i = 0; i <= NBAND; i++) {
  const lo = 40, hi = 3800
  bandEdges.push(Math.round(lo * Math.pow(hi / lo, i / NBAND) / (SR / NFFT)))
}

function fingerprint(file) {
  const buf = fs.readFileSync(file)
  const n = Math.floor(buf.length / 2 / FRAME)
  const frames = []
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  for (let f = 0; f < n; f++) {
    const off = f * FRAME * 2
    let energy = 0
    for (let i = 0; i < NFFT; i++) {
      const s = buf.readInt16LE(off + i * 2) / 32768
      energy += s * s
      // hann window
      re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NFFT - 1)))
      im[i] = 0
    }
    if (energy / NFFT < 1e-6) { frames.push(null); continue }
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
    frames.push(mag)
  }
  return frames
}

function correlate(A, B, maxLag) {
  const scores = new Float64Array(2 * maxLag + 1)
  const counts = new Int32Array(2 * maxLag + 1)
  for (let i = 0; i < A.length; i++) {
    const a = A[i]
    if (!a) continue
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const j = i + lag
      if (j < 0 || j >= B.length) continue
      const b = B[j]
      if (!b) continue
      let dot = 0
      for (let k = 0; k < NBAND; k++) dot += a[k] * b[k]
      scores[lag + maxLag] += dot
      counts[lag + maxLag]++
    }
  }
  let best = 0
  let bestLag = 0
  for (let i = 0; i < scores.length; i++) {
    if (counts[i] < 50) continue
    const avg = scores[i] / counts[i]
    if (avg > best) { best = avg; bestLag = i - maxLag }
  }
  return { best, bestLag, scores, counts }
}

/** 在给定 lag 下找最长的连续高相似段 */
function bestRun(A, B, lag, thresh) {
  let runStart = -1, bestS = -1, bestE = -1
  for (let i = 0; i < A.length; i++) {
    const j = i + lag
    let sim = 0
    if (j >= 0 && j < B.length && A[i] && B[j]) {
      for (let k = 0; k < NBAND; k++) sim += A[i][k] * B[j][k]
    }
    if (sim >= thresh) {
      if (runStart < 0) runStart = i
    } else if (runStart >= 0) {
      if (i - runStart > bestE - bestS) { bestS = runStart; bestE = i }
      runStart = -1
    }
  }
  if (runStart >= 0 && A.length - runStart > bestE - bestS) { bestS = runStart; bestE = A.length }
  return { startFrame: bestS, endFrame: bestE }
}

const [, , fileA, fileB] = process.argv
const A = fingerprint(fileA)
const B = fingerprint(fileB)
console.log(`frames: A=${A.length} B=${B.length} (${(A.length / 10).toFixed(0)}s / ${(B.length / 10).toFixed(0)}s)`)

const maxLag = Math.min(A.length, B.length) - 10
const { best, bestLag } = correlate(A, B, maxLag)
console.log(`best avg cosine = ${best.toFixed(3)} at lag = ${bestLag} frames (${(bestLag / 10).toFixed(1)}s)`)

for (const thresh of [0.9, 0.8, 0.7]) {
  const r = bestRun(A, B, bestLag, thresh)
  if (r.startFrame >= 0) {
    console.log(
      `thresh=${thresh}: A ${(r.startFrame / 10).toFixed(1)}s -> ${(r.endFrame / 10).toFixed(1)}s ` +
      `(${((r.endFrame - r.startFrame) / 10).toFixed(1)}s)  |  B ${((r.startFrame + bestLag) / 10).toFixed(1)}s -> ${((r.endFrame + bestLag) / 10).toFixed(1)}s`
    )
  } else {
    console.log(`thresh=${thresh}: no run`)
  }
}
