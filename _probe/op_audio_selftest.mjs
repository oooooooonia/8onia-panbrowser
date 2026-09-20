/** 自检 + RMS 包络：验证指纹在「同一音频不同偏移」下是否能给出完美匹配 */
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

function framesOf(file, maxFrames) {
  const buf = fs.readFileSync(file)
  const n = Math.min(Math.floor(buf.length / 2 / FRAME), maxFrames || Infinity)
  const out = [], rms = []
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT)
  for (let f = 0; f < n; f++) {
    const off = f * FRAME * 2
    let energy = 0
    for (let i = 0; i < NFFT; i++) {
      const s = buf.readInt16LE(off + i * 2) / 32768
      energy += s * s
      re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NFFT - 1)))
      im[i] = 0
    }
    rms.push(Math.sqrt(energy / NFFT))
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
  return { out, rms }
}

function corr(A, B, maxLag) {
  const sc = new Float64Array(2 * maxLag + 1), ct = new Int32Array(2 * maxLag + 1)
  for (let i = 0; i < A.length; i++) {
    if (!A[i]) continue
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const j = i + lag
      if (j < 0 || j >= B.length || !B[j]) continue
      let d = 0
      for (let k = 0; k < NBAND; k++) d += A[i][k] * B[j][k]
      sc[lag + maxLag] += d; ct[lag + maxLag]++
    }
  }
  let best = 0, bl = 0
  for (let i = 0; i < sc.length; i++) {
    if (ct[i] < 30) continue
    const a = sc[i] / ct[i]
    if (a > best) { best = a; bl = i - maxLag }
  }
  return { best, lag: bl }
}

const [, , f0, f1] = process.argv
const A = framesOf(f0)
const B = framesOf(f1)
console.log(`A frames=${A.out.length} B frames=${B.out.length}`)

// 自检：把 A 的前 170s 与 A 全量比对（应命中 lag=0，cosine≈1）
const sub = { out: A.out.slice(0, 1700) }
const self = corr(sub.out, A.out, 1690)
console.log(`self-test(前170s vs 自身): best=${self.best.toFixed(3)} lag=${self.lag} (期望 1.000 / 0)`)

// 跨集
const cross = corr(A.out, B.out, Math.min(A.out.length, B.out.length) - 10)
console.log(`cross: best=${cross.best.toFixed(3)} lag=${cross.lag} (${(cross.lag / 10).toFixed(1)}s)`)

// RMS 包络（每 5s 平均），找“音乐段”
function env(rms) {
  const out = []
  for (let i = 0; i + 50 <= rms.length; i += 50) {
    let s = 0
    for (let k = 0; k < 50; k++) s += rms[i + k]
    out.push(s / 50)
  }
  return out
}
const ea = env(A.rms), eb = env(B.rms)
console.log('\nt(s)   rms_A    rms_B   bar_A')
for (let i = 0; i < Math.min(ea.length, eb.length); i++) {
  const bar = '#'.repeat(Math.round(ea[i] * 200))
  console.log(`${String(i * 5).padStart(4)}  ${ea[i].toFixed(3)}  ${eb[i].toFixed(3)}  ${bar}`)
}
