/**
 * 流代理回归实验（对应 src/main/server.js 的 handleStream）
 *
 * A 组：修复前的写法（只有 up.pipe(res)）→ 上游静默后客户端永久挂起（复现用户报的「卡住不动只能刷新」）
 * B1 组：新写法，客户端在正常读取、上游静默 → 看门狗在 IDLE_MS 后干净收尾（客户端拿到 ABORTED，可自愈）
 * B2 组：新写法，客户端「暂停不读」（背压）导致上游静止 → 绝不能被杀；客户端恢复读取后应正常收完
 * C 组：新写法，上游先回 403 → 刷新直链重试一次 → 第二次 200，客户端拿到完整数据
 *
 * 运行：node pan-browser/_probe/stall-test.mjs
 */
import http from 'http'

const T0 = Date.now()
const ms = () => String(Date.now() - T0).padStart(6) + 'ms'
const log = (...a) => console.log(ms(), ...a)
process.on('uncaughtException', (e) => log('‼ uncaughtException:', (e && e.message) || e))
process.on('unhandledRejection', (e) => log('‼ unhandledRejection:', (e && e.message) || e))

/* 与 server.js 同一套常量（这里缩短以便观察） */
const UPSTREAM_HEADER_TIMEOUT_MS = 30000
const STREAM_IDLE_MS = 6000
const STREAM_IDLE_TICK_MS = 1000
const DLINK_RETRY_CODES = new Set([401, 403, 404, 410, 416, 500, 502, 503])

let portSeq = 19000
const nextPort = () => ++portSeq
const listen = async (srv, port) => new Promise((r) => srv.listen(port, '127.0.0.1', r))

/* ---------------- 照抄 server.js 的 fetchFollowed ---------------- */
function fetchFollowed(target, { method = 'GET', headers = {}, redirects = 0, stream = false, idleMs = UPSTREAM_HEADER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(target)
    const req = http.request(u, { method, headers }, (res) => {
      if (stream) {
        try {
          req.setTimeout(0)
        } catch { /* ignore */ }
      }
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        if (redirects >= 6) return reject(new Error('重定向次数过多'))
        fetchFollowed(new URL(res.headers.location, u).href, { method, headers, redirects: redirects + 1, stream, idleMs }).then(resolve, reject)
        return
      }
      resolve(res)
    })
    req.on('error', reject)
    req.setTimeout(idleMs, () => req.destroy(new Error('上游请求超时')))
    req.end()
  })
}

/* ---------------- 上游：按分片发送，发完即永久静默（模拟百度 CDN 停吐） ----------------
 * chunks: 发送多少个 64KB 分片；dripMs: 分片间隔；firstCode=403 时首次请求直接拒绝 */
function makeQuietUpstream({ chunks = 0, sendBytes = 1024, total = 200000, dripMs = 0, firstCode = 206 } = {}) {
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits++
    const code = firstCode === 403 && hits === 1 ? 403 : 206
    res.writeHead(code, {
      'content-type': 'video/x-matroska',
      'content-length': String(code === 403 ? 0 : total),
      'content-range': `bytes 0-${total - 1}/${total}`,
      'accept-ranges': 'bytes'
    })
    if (code === 403) return res.end()
    if (chunks > 0) {
      let i = 0
      const t = setInterval(() => {
        if (res.writableEnded) return clearInterval(t)
        try {
          res.write(Buffer.alloc(65536, 1))
        } catch {
          return clearInterval(t)
        }
        if (++i >= chunks) clearInterval(t)
      }, Math.max(1, dripMs))
      return
    }
    if (sendBytes > 0) res.write(Buffer.alloc(sendBytes, 1))
    // 不 end、不再写：模拟百度 CDN 停吐
  })
  return { srv, hits: () => hits }
}

/* ---------------- A：修复前的 handleStream ---------------- */
function oldProxy(upstreamPort) {
  return http.createServer(async (req, res) => {
    const up = await fetchFollowed(`http://127.0.0.1:${upstreamPort}/x`, {
      headers: { Range: req.headers.range || '', 'User-Agent': 'pan.baidu.com' }
    })
    const hdrs = {}
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (up.headers[k]) hdrs[k] = up.headers[k]
    res.writeHead(up.statusCode, hdrs)
    up.pipe(res)
    res.on('close', () => {
      if (!res.writableEnded) up.destroy()
    })
  })
}

/* ---------------- B/C：修复后的 handleStream（与 server.js 新版同构） ---------------- */
function newProxy(upstreamPort, { failFirst = false } = {}) {
  let dlinkCalls = 0
  return {
    dlinkCalls: () => dlinkCalls,
    srv: http.createServer(async (req, res) => {
      const range = req.headers.range || ''
      const t0 = Date.now()
      let up = null
      let lastErr = ''
      for (let attempt = 1; attempt <= 2 && !up; attempt++) {
        try {
          dlinkCalls++ // 对应 baidu.dlinkForFile(path, { force: attempt > 1 })
          const headers = { 'User-Agent': 'pan.baidu.com', Accept: '*/*', Referer: 'http://pan.baidu.com/' }
          if (range) headers.Range = range
          const r = await fetchFollowed(`http://127.0.0.1:${upstreamPort}/x`, { headers, stream: true })
          if (r.statusCode >= 400) {
            const code = r.statusCode
            lastErr = `百度直链返回 HTTP ${code}`
            r.resume()
            if (attempt === 2 || !DLINK_RETRY_CODES.has(code)) {
              log(`  [proxy] 放弃 http=${code}`)
              res.writeHead(502, { 'content-type': 'application/json' })
              return res.end(JSON.stringify({ ok: false, error: lastErr }))
            }
            log(`  [proxy] http=${code} → 刷新直链重试`)
            continue
          }
          up = r
        } catch (err) {
          lastErr = err.message || String(err)
          if (attempt === 2) {
            res.writeHead(502, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ ok: false, error: lastErr }))
          }
          log(`  [proxy] err=${lastErr} → 刷新直链重试`)
        }
      }
      if (!up) {
        res.writeHead(502, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: lastErr }))
      }
      if (failFirst) log(`  [proxy] 直链请求次数=${dlinkCalls}（含刷新重试）`)

      const hdrs = {}
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (up.headers[k]) hdrs[k] = up.headers[k]
      res.writeHead(up.statusCode || 200, hdrs)

      let bytes = 0
      let lastAt = Date.now()
      let done = false
      let idleTimer = null
      const stopWatch = () => {
        if (idleTimer) {
          clearInterval(idleTimer)
          idleTimer = null
        }
      }
      const closeBoth = (reason) => {
        if (done) return
        done = true
        stopWatch()
        try {
          if (!res.writableEnded) res.destroy()
        } catch { /* ignore */ }
        try {
          up.destroy()
        } catch { /* ignore */ }
        if (reason) log(`  [proxy] abort ${reason} bytes=${bytes} ms=${Date.now() - t0}`)
      }

      up.pipe(res)
      up.on('data', (c) => {
        bytes += c.length
        lastAt = Date.now()
      })
      up.on('error', (e) => closeBoth(`upstream-error:${(e && (e.code || e.message)) || 'unknown'}`))
      up.on('aborted', () => closeBoth('upstream-aborted'))
      up.on('close', () => {
        if (!up.readableEnded) closeBoth('upstream-close-incomplete')
        else stopWatch()
      })
      res.on('finish', () => {
        done = true
        stopWatch()
      })
      res.on('close', () => {
        if (!res.writableEnded) closeBoth('')
      })

      idleTimer = setInterval(() => {
        if (done || res.writableEnded || res.destroyed) return
        const clientPaused = up.isPaused() || res.writableNeedDrain || res.writableLength > 0
        if (clientPaused) {
          lastAt = Date.now()
          return
        }
        if (Date.now() - lastAt >= STREAM_IDLE_MS) closeBoth(`upstream-silent>${Math.round(STREAM_IDLE_MS / 1000)}s`)
      }, STREAM_IDLE_TICK_MS)
      if (idleTimer && idleTimer.unref) idleTimer.unref()
    })
  }
}

/* ---------------- 客户端：正常读取 / 读一会儿就停 ---------------- */
function client(port, label, { pauseAfterMs = 0, resumeAfterMs = 0, maxMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let got = 0
    let paused = false
    let done = false
    const fin = (how) => {
      if (done) return
      done = true
      log(`[${label}] ${how} —— 收到 ${got} 字节，耗时 ${Date.now() - t0}ms`)
      resolve(how)
    }
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
      log(`[${label}] 响应头 HTTP ${res.statusCode}`)
      res.on('data', (c) => {
        got += c.length
      })
      res.on('end', () => fin('正常 END'))
      res.on('aborted', () => fin('ABORTED（客户端拿到明确中断）'))
      res.on('error', (e) => fin('ERROR ' + e.code))
      res.on('close', () => setTimeout(() => fin('CLOSE'), 100))
      if (pauseAfterMs) {
        setTimeout(() => {
          paused = true
          res.pause()
          log(`[${label}] 模拟播放器暂停：停止读取（TCP 窗口关闭）`)
        }, pauseAfterMs)
      }
      if (resumeAfterMs) {
        setTimeout(() => {
          if (!paused) return
          paused = false
          res.resume()
          log(`[${label}] 恢复读取（缓冲区已清空）`)
        }, resumeAfterMs)
      }
    })
    const tick = setInterval(() => {
      if (done) return clearInterval(tick)
      log(`[${label}] 等待中… 已收 ${got} 字节`)
    }, 3000)
    setTimeout(() => fin('★超时仍未结束：请求永久挂起（浏览器 media 就会定格在这里）'), maxMs)
  })
}

/* ================= 开跑 ================= */
log('=== A 组：修复前的写法（上游静默） ===')
{
  const upPort = nextPort()
  const quiet = makeQuietUpstream({ sendBytes: 1024 })
  await listen(quiet.srv, upPort)
  const p = oldProxy(upPort)
  const pPort = nextPort()
  await listen(p, pPort)
  log('A:', await client(pPort, 'A', { maxMs: 12000 }))
  p.close()
  quiet.srv.close()
}

log('=== B1 组：新写法，客户端正常读取 + 上游静默 → 应看门狗收尾 ===')
{
  const upPort = nextPort()
  const quiet = makeQuietUpstream({ sendBytes: 1024 })
  await listen(quiet.srv, upPort)
  const { srv } = newProxy(upPort)
  const pPort = nextPort()
  await listen(srv, pPort)
  log('B1:', await client(pPort, 'B1', { maxMs: 12000 }))
  srv.close()
  quiet.srv.close()
}

log('=== B2 组：新写法，客户端暂停不读（背压）→ 不得被误杀，恢复后应读完 ===')
{
  const upPort = nextPort()
  const total = 512 * 1024
  // 分片慢发：客户端能先暂停下来，缓冲区被灌满 → pipe 会 pause 上游（isPaused=true）
  const quiet = makeQuietUpstream({ chunks: 8, total, dripMs: 120 })
  await listen(quiet.srv, upPort)
  const { srv } = newProxy(upPort)
  const pPort = nextPort()
  await listen(srv, pPort)
  const r = await client(pPort, 'B2', { pauseAfterMs: 300, resumeAfterMs: 10000, maxMs: 18000 })
  log('B2:', r, '（暂停跨越了 6s 看门狗窗口仍未被杀 = 正确）')
  srv.close()
  quiet.srv.close()
}

log('=== B3 组：客户端暂停 + 上游也彻底静默 → 看门狗按「静默」判死（已知残留情形）===')
{
  const upPort = nextPort()
  // 12×64KB 够把 socket/Node 缓冲区灌满，保证 pipe 会 pause 上游（否则测不到背压分支）
  const quiet = makeQuietUpstream({ chunks: 12, sendBytes: 0, total: 1024 * 1024, dripMs: 60 })
  await listen(quiet.srv, upPort)
  const { srv } = newProxy(upPort)
  const pPort = nextPort()
  await listen(srv, pPort)
  const r = await client(pPort, 'B3', { pauseAfterMs: 400, resumeAfterMs: 9000, maxMs: 18000 })
  log(
    'B3:',
    r,
    '—— 数据下沉到内核后背压标记消失，看门狗按静默判死；生产阈值是 5 分钟（测试里缩短成 6s），' +
      '且这一情形由前端自愈在恢复播放时自动 load() 续播，不会退化成「必须刷新页面」'
  )
  srv.close()
  quiet.srv.close()
}

log('=== C 组：新写法，上游先 403 → 刷新直链重试 ===')
{
  const upPort = nextPort()
  const quiet = makeQuietUpstream({ sendBytes: 2048, total: 2048, firstCode: 403 })
  await listen(quiet.srv, upPort)
  const { srv, dlinkCalls } = newProxy(upPort, { failFirst: true })
  const pPort = nextPort()
  await listen(srv, pPort)
  const r = await client(pPort, 'C', { maxMs: 8000 })
  log(`C: ${r}（上游被请求 ${quiet.hits()} 次，直链取得 ${dlinkCalls()} 次）`)
  srv.close()
  quiet.srv.close()
}

log('=== 结论 ===')
log('A 组若为「★超时仍未结束」= 复现了旧 bug；B1 应为 ABORTED；B2 应为 正常 END；C 应为 正常 END')
process.exit(0)
