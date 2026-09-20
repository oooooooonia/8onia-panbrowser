import { useEffect, useState } from 'react'
import {
  HardDrive, MonitorPlay, Database, ScanLine, RefreshCw, FolderInput, KeyRound,
  ChevronRight, Check, ExternalLink, Wifi, Info, Plug, Trash2, Loader2, Copy, Captions, RotateCcw,
  SkipForward, Scissors, MessageSquareText
} from 'lucide-react'
import { useApp } from '../store/app'
import { api, copyText, isDesktop } from '../lib/api'
import { VIP_NAME } from '../lib/format'

export default function SettingsPage() {
  const server = useApp((s) => s.server)
  const refreshStatus = useApp((s) => s.refreshStatus)
  const notify = useApp((s) => s.notify)
  const [busy, setBusy] = useState('')

  // 手动凭证编辑
  const cfg = server?.config || {}
  // 全局字幕字体（主进程解析，这里只展示/可手动指定）
  const sf = server?.subtitleFont || {}
  const setFontPath = async (p) => {
    await run('保存', () => api.saveConfig({ subtitleFontPath: p }))
    try {
      await useApp.getState().refreshStatus()
    } catch { /* ignore */ }
    notify(p ? '已切换全局字幕字体（重开视频生效）' : '已恢复自动选择字幕字体', 'ok')
  }
  const pickFont = async () => {
    if (!window.pan || !window.pan.selectFile) return
    const p = await window.pan.selectFile()
    if (p) await setFontPath(p)
  }
  const [clientId, setClientId] = useState(cfg.clientId || '')
  const [clientSecret, setClientSecret] = useState(cfg.clientSecret || '')
  const [refreshToken, setRefreshToken] = useState(cfg.refreshToken || '')
  const [showManual, setShowManual] = useState(false)

  // AList 导入
  const [alistDir, setAlistDir] = useState(cfg.alistDir || '')
  const [found, setFound] = useState(null) // {dbPath, storages[]}

  // PotPlayer
  const [ppPath, setPpPath] = useState(cfg.potplayerPath || '')
  const [ppDetect, setPpDetect] = useState(null)

  // 内嵌字幕（ffmpeg 抽取）
  const [ffmpegPath, setFfmpegPath] = useState(cfg.ffmpegPath || '')
  const [ffmpegOk, setFfmpegOk] = useState(null)

  // 服务
  const [hostBind, setHostBind] = useState(cfg.hostBind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1')
  // 字幕外观（SRT 增强渲染）
  const [subFont, setSubFont] = useState(Math.round(Number(cfg.subFontScale || 0.05) * 100))
  const [subOutline, setSubOutline] = useState(Number(cfg.subOutline || 1.4))
  const [subShadow, setSubShadow] = useState(Number(cfg.subShadow || 0.6))
  const [subWeight, setSubWeight] = useState(cfg.subWeight || 'medium')

  // OP/ED 跳过
  const [skipEnabled, setSkipEnabled] = useState(cfg.skipEnabled !== false)
  const [skipAutoOp, setSkipAutoOp] = useState(!!cfg.skipAutoOp)
  const [skipAutoEd, setSkipAutoEd] = useState(!!cfg.skipAutoEd)
  const [skipDelaySec, setSkipDelaySec] = useState(Number(cfg.skipDelaySec ?? 2))
  const [skipUseChapters, setSkipUseChapters] = useState(cfg.skipUseChapters !== false)
  const [skipUseSubtitles, setSkipUseSubtitles] = useState(cfg.skipUseSubtitles !== false)
  const [skipMarks, setSkipMarks] = useState([])
  const [skipStats, setSkipStats] = useState(null)
  const [dmCache, setDmCache] = useState(null)
  const refreshDmCache = async () => {
    try {
      const r = await api.danmakuCache()
      if (r && r.ok) setDmCache(r)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refreshDmCache()
    setClientId(cfg.clientId || '')
    setClientSecret(cfg.clientSecret || '')
    setRefreshToken(cfg.refreshToken || '')
    setAlistDir(cfg.alistDir || '')
    setPpPath(cfg.potplayerPath || '')
    setFfmpegPath(cfg.ffmpegPath || '')
    setHostBind(cfg.hostBind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1')
    setSubFont(Math.round(Number(cfg.subFontScale || 0.05) * 100))
    setSubOutline(Number(cfg.subOutline || 1.4))
    setSubShadow(Number(cfg.subShadow || 0.6))
    setSubWeight(cfg.subWeight || 'medium')
    setSkipEnabled(cfg.skipEnabled !== false)
    setSkipAutoOp(!!cfg.skipAutoOp)
    setSkipAutoEd(!!cfg.skipAutoEd)
    setSkipDelaySec(Number(cfg.skipDelaySec ?? 2))
    setSkipUseChapters(cfg.skipUseChapters !== false)
    setSkipUseSubtitles(cfg.skipUseSubtitles !== false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server])

  const loadSkipMeta = async () => {
    try {
      const [m, s] = await Promise.all([api.skipMarks(''), api.skipStats()])
      setSkipMarks((m && m.marks) || [])
      setSkipStats(s || null)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    loadSkipMeta()
  }, [])

  useEffect(() => {
    api
      .ffmpegStatus()
      .then((r) => setFfmpegOk(!!(r && r.available)))
      .catch(() => setFfmpegOk(false))
  }, [])

  const account = server?.account || null
  const run = async (label, fn) => {
    setBusy(label)
    try {
      const out = await fn()
      await refreshStatus()
      return out
    } finally {
      setBusy('')
    }
  }

  const saveManual = async () => {
    try {
      await run('保存', () =>
        api.saveConfig({ clientId, clientSecret, refreshToken })
      )
      notify('凭证已保存，正在测试连接…', 'ok')
      const t = await api.testConfig()
      if (!t.ok) notify(t.error, 'error')
      else notify(`连接成功：${t.account.baiduName || t.account.netdiskName}`, 'ok')
      refreshStatus()
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  const doScan = async () => {
    try {
      const r = await run('扫描', () => api.alistScan(alistDir))
      if (!r.ok) return notify(r.error, 'error')
      setFound(r)
      if (!r.storages.length) notify('未找到百度网盘存储（已排除禁用项）', 'error')
      else notify(`找到 ${r.storages.length} 个百度网盘存储（${r.dbPath}）`, 'ok')
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  const doImport = async (st) => {
    try {
      const r = await run('导入', () => api.alistImport(found.dbPath, st.id))
      if (!r.ok) return notify(r.error, 'error')
      if (r.account) notify(`导入成功：${r.account.netdiskName || r.account.baiduName}（VIP:${VIP_NAME[r.account.vipType] || r.account.vipType}）`, 'ok')
      else notify(`凭证已导入，但测试连接失败：${r.accountError}`, 'error')
      setFound(null)
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  const doDetectPP = async () => {
    const r = await run('检测', api.detectPotplayer)
    setPpDetect(r)
    if (r.found) {
      setPpPath(r.path)
      notify(`检测到 PotPlayer：${r.path}`, 'ok')
    } else {
      notify('未自动找到 PotPlayer，请手动选择可执行文件', 'error')
    }
  }

  const savePP = async () => {
    await run('保存', () => api.saveConfig({ potplayerPath: ppPath }))
    notify('PotPlayer 路径已保存', 'ok')
  }

  const pickPP = async () => {
    if (window.pan && window.pan.selectFile) {
      const p = await window.pan.selectFile()
      if (p) {
        setPpPath(p)
        await run('保存', () => api.saveConfig({ potplayerPath: p }))
        notify('PotPlayer 路径已保存', 'ok')
      }
    } else {
      notify('当前环境不支持原生文件选择，请手动输入路径', 'error')
    }
  }

  const saveHost = async () => {
    await run('保存', () => api.saveConfig({ hostBind }))
    notify('监听地址已保存（重启应用生效）', 'ok')
  }

  const clearAcc = async () => {
    await run('清除', api.clearConfig)
    notify('已清除网盘凭证', 'ok')
  }

  const usage = account && account.total ? (account.used / account.total) * 100 : 0
  const fmtG = (b) => (b ? (b / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '—')

  return (
    <div className="page settings">
      {!isDesktop ? <style>{'.only-desktop{display:none !important}'}</style> : null}
      {/* ---------- 账号与挂载 ---------- */}
      <section className="card">
        <div className="card-title">
          <HardDrive size={16} /> 百度网盘账号
          {cfg.configured ? <span className="pill ok">已挂载</span> : <span className="pill warn">未挂载</span>}
        </div>
        {cfg.configured && account ? (
          <div className="acct">
            <div className="acct-name">
              <span className="avatar">{String(account.netdiskName || account.baiduName || '网')[0]}</span>
              <div>
                <b>{account.netdiskName || account.baiduName}</b>
                <div className="dim small">{VIP_NAME[account.vipType] || `VIP${account.vipType}`} · uid {account.uid}</div>
              </div>
            </div>
            {usage ? (
              <div className="usage">
                <div className="usage-bar"><i style={{ width: `${Math.min(100, usage)}%` }} /></div>
                <div className="dim small">已用 {fmtG(account.used)} / 共 {fmtG(account.total)}</div>
              </div>
            ) : null}
            <div className="card-row"><span className="dim">挂载根目录</span><code>{cfg.rootFolderPath || '/'}</code></div>
            <div className="btn-row">
              <button className="btn" disabled={!!busy} onClick={async () => {
                const r = await api.testConfig()
                notify(r.ok ? `连接正常：${r.account.netdiskName || r.account.baiduName}` : r.error, r.ok ? 'ok' : 'error')
              }}>
                <RefreshCw size={14} /> 测试连接
              </button>
              <button className="btn ghost danger" onClick={clearAcc}><Trash2 size={14} /> 清除凭证</button>
            </div>
          </div>
        ) : (
          <div className="not-set">
            <p className="dim">尚未挂载百度网盘。推荐直接从本机 AList 导入（下一步），或手动填写开放平台凭证。</p>
          </div>
        )}
      </section>

      {/* ---------- 字幕外观（SRT 增强渲染，桌面） ---------- */}
      <section className="card only-desktop">
        <div className="card-title">
          <Captions size={16} /> SRT 字幕外观
          <span className="pill info">libass 渲染</span>
        </div>
        <p className="dim small note">
          把 SRT / VTT / SUB / SBV 以增强 ASS 交给 libass 渲染，观感接近 PotPlayer（白字+描边+阴影）；真 ASS/SSA 保留原样式。改完“重开视频/切换字幕”即生效。
        </p>
        <div className="h-row wrap">
          <label className="radio-line">字号 %<input className="num-input" type="number" min={2} max={12} step={0.5} value={subFont} onChange={(e) => setSubFont(Number(e.target.value))} /></label>
          <label className="radio-line">描边
            <input className="num-input" type="number" min={0} max={5} step={0.2} value={subOutline} onChange={(e) => setSubOutline(Number(e.target.value))} />
          </label>
          <label className="radio-line">阴影
            <input className="num-input" type="number" min={0} max={4} step={0.2} value={subShadow} onChange={(e) => setSubShadow(Number(e.target.value))} />
          </label>
          <label className="radio-line">
            <span className="dim small" style={{ alignSelf: 'center' }}>字幕粗细</span>
            {[['normal', '常规'], ['medium', '中等'], ['bold', '加粗']].map(([v, label]) => (
              <button key={v} type="button" className={'chip-btn ' + (subWeight === v ? 'on' : '')} onClick={() => setSubWeight(v)}>
                {label}
              </button>
            ))}
          </label>
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            className="btn small"
            disabled={!!busy}
            onClick={async () => {
              try {
                await api.saveConfig({ subFontScale: (subFont || 5) / 100, subOutline, subShadow, subWeight })
                notify('字幕外观已保存（重开视频生效）', 'ok')
              } catch (e) {
                notify(e.message, 'error')
              }
            }}
          >
            <Check size={14} /> 保存
          </button>
          <button
            className="btn ghost small"
            onClick={() => {
              setSubFont(5); setSubOutline(1.4); setSubShadow(0.6); setSubWeight('medium')
            }}
          >
            <RotateCcw size={13} /> 恢复 PotPlayer 默认
          </button>
        </div>
        {/* 全局字幕字体：字幕组的 ASS 一般指定「方正准圆_GBK」这类圆角中文字体，
            而浏览器里的 libass 看不到系统字体，所以由主进程挑一份喂给它 */}
        <div className="h-row wrap" style={{ marginTop: 10, gap: 6 }}>
          <span className="dim small">全局字幕字体：</span>
          <b style={{ fontSize: 12.5 }}>{sf.family || '（未找到可用字体）'}</b>
          <span className="dim small">
            {sf.forced
              ? '· 手动指定'
              : sf.installed
                ? '· 系统已安装（' + sf.requested + '）'
                : sf.fallback
                  ? '· 未装圆角中文字体，已退到全局字体'
                  : '· 未装 ' + sf.requested + '，用系统圆体顶替'}
          </span>
        </div>
        <div className="btn-row">
          <button className="btn ghost small" disabled={!!busy} onClick={pickFont}>
            <Captions size={13} /> 选择字体文件…
          </button>
          <button className="btn ghost small" disabled={!cfg.subtitleFontPath || !!busy} onClick={() => setFontPath('')}>
            <RotateCcw size={13} /> 恢复自动
          </button>
          <span className="dim small">只在本机读取该字体文件，不会上传；换完「重开视频」生效</span>
        </div>
      </section>

      {/* ---------- 片头片尾（OP/ED）跳过 ---------- */}
      <section className="card">
        <div className="card-title">
          <SkipForward size={16} /> 跳过片头片尾（OP/ED）
          {skipEnabled ? <span className="pill ok">已开启</span> : <span className="pill warn">已关闭</span>}
        </div>
        <p className="dim small note">
          播放器会按三层信号自动定位 OP/ED：<b>视频章节（打标）</b> → <b>字幕</b>（ASS 样式名/歌词块、外挂字幕跨集重复文本） → <b>手动标记</b>（最可靠）。
          命中后在播放器右下角浮出「跳过 OP」按钮；也可在这里开自动跳过。检测结果按文件缓存，首次会稍慢。
        </p>
        <div className="h-row wrap">
          <label className="radio-line">
            <input type="checkbox" checked={skipEnabled} onChange={(e) => setSkipEnabled(e.target.checked)} /> 启用跳过功能
          </label>
          <label className="radio-line">
            <input type="checkbox" checked={skipUseChapters} onChange={(e) => setSkipUseChapters(e.target.checked)} /> 使用章节（打标）
          </label>
          <label className="radio-line">
            <input type="checkbox" checked={skipUseSubtitles} onChange={(e) => setSkipUseSubtitles(e.target.checked)} /> 使用字幕信号
          </label>
        </div>
        <div className="h-row wrap" style={{ marginTop: 8 }}>
          <label className="radio-line">
            <input type="checkbox" checked={skipAutoOp} onChange={(e) => setSkipAutoOp(e.target.checked)} /> 自动跳过 OP
          </label>
          <label className="radio-line">
            <input type="checkbox" checked={skipAutoEd} onChange={(e) => setSkipAutoEd(e.target.checked)} /> 自动跳过 ED
          </label>
          <label className="radio-line">
            自动跳过延迟
            <input
              className="num-input"
              type="number"
              min={0}
              max={60}
              step={1}
              value={skipDelaySec}
              onChange={(e) => setSkipDelaySec(Number(e.target.value))}
            />
            秒
          </label>
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            className="btn small"
            disabled={!!busy}
            onClick={async () => {
              try {
                await api.saveConfig({
                  skipEnabled,
                  skipAutoOp,
                  skipAutoEd,
                  skipDelaySec,
                  skipUseChapters,
                  skipUseSubtitles
                })
                notify('跳过设置已保存', 'ok')
              } catch (e) {
                notify(e.message, 'error')
              }
            }}
          >
            <Check size={14} /> 保存
          </button>
          <button
            className="btn ghost small"
            onClick={async () => {
              try {
                await api.skipClearCache()
                await loadSkipMeta()
                notify('检测缓存已清除（下次播放重新检测）', 'ok')
              } catch (e) {
                notify(e.message, 'error')
              }
            }}
          >
            <RotateCcw size={13} /> 清除检测缓存
          </button>
          {skipStats ? (
            <span className="dim small">
              已缓存 {skipStats.cachedFiles} 个文件（其中 {skipStats.subAnalyzed} 个已分析字幕）· {skipStats.markedSeries} 个剧集有手动标记
            </span>
          ) : null}
        </div>

        {skipMarks.length ? (
          <div className="found">
            <div className="dim small"><Scissors size={12} /> 手动标记（优先级最高，覆盖自动检测）</div>
            {skipMarks.map((m, i) => (
              <div key={i} className="found-item">
                <Scissors size={15} />
                <div className="flex1">
                  <b>{m.file || (m.seriesDir.split('/').pop() || m.seriesDir)}</b>
                  <span className="dim small">
                    {m.scope === 'series' ? '整剧集' : '单集'} · {m.seriesDir}
                    {m.op ? ` · OP ${Math.round(m.op.start)}–${Math.round(m.op.end)}s` : ''}
                    {m.ed ? ` · ED ${Math.round(m.ed.start)}–${Math.round(m.ed.end)}s` : ''}
                  </span>
                </div>
                <button
                  className="btn ghost small danger"
                  onClick={async () => {
                    try {
                      const base = { path: m.seriesDir + '/' + m.file, scope: m.scope }
                      if (m.op) await api.skipClearMark({ ...base, type: 'op' })
                      if (m.ed) await api.skipClearMark({ ...base, type: 'ed' })
                      await loadSkipMeta()
                      notify('标记已删除', 'ok')
                    } catch (e) {
                      notify(e.message, 'error')
                    }
                  }}
                >
                  <Trash2 size={13} /> 删除
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ---------- AList 导入 ---------- */}
      <section className="card only-desktop">
        <div className="card-title">
          <Database size={16} /> 从 AList 导入凭证
          <span className="pill info">只读</span>
        </div>
        <p className="dim small note">
          读取你正在运行的 AList 数据目录里的 <code>data.db</code>（兼容正在运行的 WAL 库），
          导入其中的百度网盘存储（driver=BaiduNetdisk）的 client_id / secret / refresh_token。不会修改 AList。
        </p>
        <div className="h-row">
          <input className="input" value={alistDir} onChange={(e) => setAlistDir(e.target.value)} placeholder="AList 数据目录，如 C:\Users\you\AList\data" />
          {window.pan && window.pan.selectDirectory ? (
            <button className="icon-btn" title="浏览选择目录" onClick={async () => {
              const p = await window.pan.selectDirectory()
              if (p) { setAlistDir(p); await api.saveConfig({ alistDir: p }) }
            }}>
              <FolderInput size={16} />
            </button>
          ) : null}
          <button className="btn" disabled={!!busy} onClick={doScan}>
            {busy === '扫描' ? <Loader2 size={14} className="spin" /> : <ScanLine size={14} />} 扫描
          </button>
        </div>

        {found ? (
          <div className="found">
            <div className="dim small">数据库：{found.dbPath}</div>
            {found.storages.map((st) => (
              <div key={st.id} className="found-item">
                <Plug size={15} />
                <div className="flex1">
                  <b>{st.driver}</b>
                  <span className="dim small">挂载点 {st.mountPath} · {st.status}</span>
                </div>
                <button className="btn small" disabled={!!busy} onClick={() => doImport(st)}>
                  {busy === '导入' ? <Loader2 size={13} className="spin" /> : <Check size={13} />} 导入此账号
                </button>
              </div>
            ))}
            {!found.storages.length ? <div className="dim small">未找到百度网盘存储（BaiduNetdisk / baidu_netdisk）。</div> : null}
          </div>
        ) : null}
      </section>

      {/* ---------- 手动凭证 ---------- */}
      <section className="card">
        <div className="section-title">
          <MessageSquareText size={16} /> 弹幕缓存（弹弹play 识别 / 网盘 xml）
        </div>
        <div className="dim small">
          识别并播放过一集后，该集弹幕会以 xml 存到本地缓存目录；再次观看直接读本地文件，不再重复识别/下载。
        </div>
        <div className="row">
          <button
            className="chip-btn"
            onClick={async () => {
              try {
                const r = await api.clearDanmakuCache()
                notify(`已清空弹幕缓存（删除 ${r.removed} 个文件）`, 'ok')
                await refreshDmCache()
              } catch (e) {
                notify(e.message, 'error')
              }
            }}
          >
            <Trash2 size={13} /> 清空弹幕缓存
          </button>
          <button className="chip-btn" onClick={() => refreshDmCache()}>
            <RotateCcw size={13} /> 刷新
          </button>
          {dmCache ? (
            <span className="dim small">
              共 {dmCache.total} 个文件 · {dmCache.size > 1048576 ? (dmCache.size / 1048576).toFixed(1) + ' MB' : Math.round(dmCache.size / 1024) + ' KB'} · {dmCache.dir}
            </span>
          ) : null}
        </div>
        {dmCache && dmCache.items.length ? (
          <div className="found">
            {dmCache.items.slice(0, 10).map((it) => (
              <div key={it.file} className="found-item">
                <span className="ellip">{it.file}</span>
                <span className="dim small">
                  {it.count ? it.count + ' 条 · ' : ''}
                  {it.size > 1048576 ? (it.size / 1048576).toFixed(1) + ' MB' : Math.round(it.size / 1024) + ' KB'}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <section className="card">
        <div className="card-title click" onClick={() => setShowManual((v) => !v)}>
          <KeyRound size={16} /> 手动填写开放平台凭证 <ChevronRight size={14} className={showManual ? 'rot' : ''} />
        </div>
        {showManual ? (
          <div className="stack">
            <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="client_id（API Key）" />
            <input className="input" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="client_secret（Secret Key）" />
            <textarea className="input" rows={2} value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="refresh_token" />
            <div className="btn-row">
              <button className="btn" disabled={!!busy} onClick={saveManual}><Plug size={14} /> 保存并测试</button>
            </div>
          </div>
        ) : null}
      </section>

      {/* ---------- PotPlayer ---------- */}
      <section className="card only-desktop">
        <div className="card-title"><MonitorPlay size={16} /> PotPlayer 外部播放</div>
        <p className="dim small note">
          网页无法播放的编码（H.265 / AC3 等）可直接交给 PotPlayer 播放原画。应用会以本地流地址拉起 PotPlayer（已内置 UA 处理）。
        </p>
        <div className="h-row">
          <input className="input" value={ppPath} onChange={(e) => setPpPath(e.target.value)} placeholder="PotPlayerMini64.exe 完整路径" />
          <button className="btn" disabled={!!busy} onClick={doDetectPP}>
            {busy === '检测' ? <Loader2 size={14} className="spin" /> : <ScanLine size={14} />} 检测
          </button>
          <button className="btn ghost" onClick={pickPP}><FolderInput size={14} /> 选择</button>
          <button className="btn ghost" onClick={savePP}><Check size={14} /> 保存</button>
        </div>
        {ppDetect && !ppDetect.found ? (
          <div className="dim small">未自动找到，已检查：{ppDetect.searched.join('；')}</div>
        ) : null}
        {server?.potplayer?.found ? <div className="dim small ok-txt">当前生效：{server.potplayer.path}</div> : null}
      </section>

      {/* ---------- 内嵌字幕（ffmpeg 抽取） ---------- */}
      <section className="card only-desktop">
        <div className="card-title"><Captions size={16} /> 内嵌字幕（ffmpeg）</div>
        <p className="dim small note">
          视频容器（MKV/MP4）里封装的文本字幕轨（SRT/ASS/mov_text 等）无法直接给网页播放器，应用用 ffmpeg 从本地流里把字幕轨抽取出来再渲染。
          留空自动查找常见目录（本机 <code>D:\ffmpeg-7.1-full_build\bin</code>）；找不到时播放页的内嵌字幕不会出现。
        </p>
        <div className="h-row">
          <input className="input" value={ffmpegPath} onChange={(e) => setFfmpegPath(e.target.value)} placeholder="ffmpeg 目录，如 D:\ffmpeg-7.1-full_build\bin" />
          <button className="btn" disabled={!!busy} onClick={async () => {
            await run('保存', () => api.saveConfig({ ffmpegPath }))
            notify('ffmpeg 路径已保存', 'ok')
          }}><Check size={14} /> 保存</button>
        </div>
        {ffmpegOk !== null ? (
          <div className={`dim small ${ffmpegOk ? 'ok-txt' : ''}`}>
            {ffmpegOk ? '已检测到 ffmpeg，可抽取内嵌字幕' : '未检测到 ffmpeg，内嵌字幕不可用'}
          </div>
        ) : null}
      </section>

      {/* ---------- 本地服务 ---------- */}
      <section className="card only-desktop">
        <div className="card-title"><Wifi size={16} /> 本地服务</div>
        <div className="h-row wrap">
          <label className="radio-line">
            <input type="radio" checked={hostBind === '127.0.0.1'} onChange={() => setHostBind('127.0.0.1')} />
            <span>仅本机（127.0.0.1）</span>
          </label>
          <label className="radio-line">
            <input type="radio" checked={hostBind === '0.0.0.0'} onChange={() => setHostBind('0.0.0.0')} />
            <span>局域网可访问（0.0.0.0，手机可用）</span>
          </label>
          <button className="btn small" disabled={!!busy} onClick={saveHost}><Check size={13} /> 保存（重启生效）</button>
        </div>
        <div className="dim small">
          端口：{server?.server?.port || cfg.port} · 网页原画在线播放即服务端携带{' '}
          <code>User-Agent: pan.baidu.com</code> 代理百度直链（20MB 以上文件必需），支持 Range 拖动。
        </div>
      </section>

      {/* ---------- 关于 ---------- */}
      <section className="card">
        <div className="card-title"><Info size={16} /> 关于</div>
        <div className="dim small stack">
          <div>PanBrowser {server ? '' : ''}（个人自用）· Electron {server ? '' : ''} 本地运行</div>
          <div>接口与 AList 百度网盘驱动（BaiduNetdisk, official 接口）保持一致：openapi 刷新令牌 / xpan 列表 / filemetas dlink。</div>
          <div>参考：<ExternalLink size={12} /> AList 文档 - 百度网盘驱动（UA 说明）</div>
          <div>仅供个人学习使用；所有文件版权归权利人所有。</div>
        </div>
      </section>
    </div>
  )
}
