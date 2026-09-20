import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { Baidu } from './api/baidu.js'
import { startServer } from './server.js'
import { loadConfig, saveConfig } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !!process.env['ELECTRON_RENDERER_URL']
const isHeadless = process.env['PANBOX_HEADLESS'] === '1'
const isDebug = process.env['PANBOX_DEBUG'] === '1'

let mainWindow = null
let serverPort = 0

if (process.env.PANBOX_USERDATA) {
  app.setPath('userData', process.env.PANBOX_USERDATA)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// 主进程异常兜底：记录而非弹原生错误窗
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack ? e.stack : e))
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack ? e.stack : e))

const crashLog = (s) => {
  try {
    const f = path.join(__dirname, '../../.debug/log.txt')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, `${new Date().toISOString()} ${s}\n`)
  } catch {}
}
app.on('child-process-gone', (_e, d) => {
  const line = `child-process-gone ${d ? JSON.stringify({ type: d.type, reason: d.reason, exitCode: d.exitCode }) : ''}`
  console.error('[' + line + ']')
  crashLog(line)
})

function createMainWindow() {
  const cfg = loadConfig()
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 380,
    minHeight: 620,
    show: false,
    title: 'PanBrowser · 百度网盘浏览器',
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })
  // 调试用：PANBOX_WIN=430x780 指定窗口尺寸（仅 PANBOX_DEBUG=1 时生效，便于验证窄屏/矮屏布局）
  if (isDebug && process.env.PANBOX_WIN) {
    const m = String(process.env.PANBOX_WIN).match(/^(\d{3,5})x(\d{3,5})$/)
    if (m) mainWindow.setSize(Number(m[1]), Number(m[2]))
  }
  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    crashLog(`render-process-gone ${JSON.stringify(d)}`)
    console.error('[render-process-gone]', JSON.stringify(d))
  })
  mainWindow.webContents.on('destroyed', () => crashLog('webContents-destroyed'))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  const url = isDev
    ? `${process.env['ELECTRON_RENDERER_URL']}?apiPort=${serverPort}`
    : `http://127.0.0.1:${serverPort}/?apiPort=${serverPort}`
  mainWindow.loadURL(url)
  if (isDebug) debugDrive()
}

/* ---------------- 调试驱动（仅 PANBOX_DEBUG=1 时启用）：自动进入目录→点开视频→截屏+数值诊断 ---------------- */
function debugDrive() {
  const wc = mainWindow.webContents
  const SHOT_DIR = path.join(__dirname, '../../.debug')
  const LOG = path.join(SHOT_DIR, 'log.txt')
  const msgs = []
  const log = (s) => {
    try {
      fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`)
    } catch {}
  }
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
  } catch {}
  log('=== debug start ===')
  const analyze = (img) => {
    try {
      const bmp = img.toBitmap()
      const { width, height } = img.getSize()
      let black = 0
      let lumSum = 0
      const stride = Math.max(1, Math.floor((width * height) / 40000))
      let n = 0
      for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
          const i = (y * width + x) * 4
          const r = bmp[i]
          const g = bmp[i + 1]
          const b = bmp[i + 2]
          const lum = (r + g + b) / 3
          lumSum += lum
          n++
          if (lum < 24) black++
        }
      }
      return `size=${width}x${height} avgLum=${(lumSum / n).toFixed(1)} blackPct=${((black / n) * 100).toFixed(1)}%`
    } catch (e) {
      return 'analyze-fail ' + e.message
    }
  }
  const shot = async (name) => {
    try {
      const img = await wc.capturePage()
      fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), img.toPNG())
      log(`shot ${name} ${analyze(img)}`)
      console.log(`[debug] shot ${name} ${analyze(img)}`)
    } catch (e) {
      log('shot fail ' + name + ' ' + e.message)
    }
  }
  wc.on('console-message', (_e, level, msg) => {
    const line = `c[${level}] ${String(msg).slice(0, 1200)}`
    log(line)
    msgs.push(line)
  })
  wc.on('render-process-gone', (_e, d) => log('render-gone ' + JSON.stringify(d)))
  wc.on('unresponsive', () => log('unresponsive-event'))
  wc.on('responsive', () => log('responsive-event'))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const runJS = (code, timeoutMs = 3000) =>
    Promise.race([
      wc.executeJavaScript(code, true).catch((e) => 'js-error: ' + e.message),
      sleep(timeoutMs).then(() => 'js-timeout')
    ])

  // 独立心跳探针：点开视频后每秒探测主线程是否响应
  const startProbe = () => {
    let n = 0
    const timer = setInterval(async () => {
      n++
      const r = await runJS('1+1', 900)
      const state = await runJS(
        `(()=>{const ov=!!document.querySelector('.player-overlay');const v=document.querySelector('video');return JSON.stringify({ov,hasV:!!v,err:v&&v.error?(v.error.code+':'+v.error.message):null,txt:(document.body.innerText||'').slice(0,40)})})()`,
        900
      )
      log(`probe#${n} alive=${r === 2} ${state}`)
      if (n >= 12) clearInterval(timer)
    }, 1100)
  }

  wc.once('did-finish-load', async () => {
    await sleep(300)
    await runJS(
      `window.__PANBOX_LIBASS_DEBUG__=true;window.__e=[];addEventListener('error',e=>{__e.push('E:'+(e.error&&e.error.stack||e.message));try{console.error('WINERR '+(e.error&&e.error.stack||e.message))}catch(_){}});addEventListener('unhandledrejection',e=>{__e.push('R:'+(e.reason&&e.reason.stack||e.reason));try{console.error('REJERR '+(e.reason&&e.reason.stack||e.reason))}catch(_){}});'ok'`
    )
    await sleep(3200)
    await shot('1-home')
    // 调试目标目录：默认从根目录开始逐层进入；可用 PANBOX_TARGET=<网盘路径> 覆盖
    const TARGET = process.env.PANBOX_TARGET || '/'
    // 用路径编辑框直接跳到目标目录
    const jump = await runJS(
      `(()=>{const c=document.querySelector('.crumb-click');if(c)c.click();return !!c})()`
    )
    log('jump-open ' + jump)
    await sleep(600)
    const jump2 = await runJS(
      `(()=>{const inp=document.querySelector('.crumb-edit input');if(!inp)return 'no-input';const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;setter.call(inp,${JSON.stringify(TARGET)});inp.dispatchEvent(new Event('input',{bubbles:true}));const f=inp.closest('form');if(f)f.requestSubmit();return 'submitted'})()`
    )
    log('jump-go ' + jump2)
    await sleep(3500)
    await shot('2-videodir')
    // 逐层进入目录找第一个可播视频（最多 4 层）
    let clicked = ''
    for (let depth = 0; depth < 4; depth++) {
      const step = await runJS(
        `(()=>{const exts=['.mp4','.mkv','.mov','.m4v','.webm','.ts','.m2ts','.flv','.avi','.wmv','.rmvb','.rm','.mpg','.mpeg'];const rows=[...document.querySelectorAll('.row')];if(!rows.length)return 'no-rows';const m=rows.find(el=>{const t=(el.textContent||'').toLowerCase();return exts.some(e=>t.includes(e))});if(m){m.click();return 'media:'+(m.textContent||'').slice(0,46)}const d=rows.find(el=>el.querySelector('svg.c-folder'));if(d){d.click();return 'dir:'+(d.textContent||'').slice(0,40)}return 'nothing rows='+rows.length})()`
      )
      log(`step2 depth${depth}: ${step}`)
      if (step.startsWith('media:')) {
        clicked = step
        break
      }
      if (step.startsWith('no-rows') || step.startsWith('nothing')) break
      await sleep(2600) // 进入子目录等列表
    }
    await sleep(9000)
    await shot('3-player')
    const assProbe = await runJS(
      `(async()=>{const c=document.querySelector('.ass-overlay canvas')||document.querySelector('.libassjs-canvas')||document.querySelector('.ass-canvas');if(!c)return JSON.stringify({canvas:false});const v=document.querySelector('video');let found=false;const times=[5,30,60,120,180,300];for(const t of times){try{if(v){v.currentTime=t}}catch{}await new Promise(r=>setTimeout(r,1400));try{const ctx=c.getContext('2d');const img=ctx.getImageData(0,0,c.width,c.height).data;for(let i=3;i<img.length;i+=4000){if(img[i]>10){found=true;break}}}catch{}}return JSON.stringify({canvas:true,w:c.width,h:c.height,found})})()`
    )
    log('assCanvasProbe ' + assProbe)
    const skipProbe = await runJS(
      `(()=>{const bar=document.querySelector('.sub-bar.skip-bar');const float=document.querySelector('.skip-float');const ranges=[...document.querySelectorAll('.skip-ranges i')];const chips=[...document.querySelectorAll('.sub-bar.skip-bar .sub-chip')].map(b=>b.innerText.replace(/\\n/g,' ').trim());return JSON.stringify({bar:!!bar,barText:bar?bar.innerText.replace(/\\n+/g,'|').slice(0,160):'',chips,float:!!float,floatVisible:!!(float&&float.offsetParent!==null),floatText:float?float.innerText.trim():'',ranges:ranges.map(r=>r.className+'@'+r.style.left+'/'+r.style.width),markBtn:!!document.querySelector('.mark-panel')})})()`,
      4000
    )
    log('skipDomProbe ' + skipProbe)
    const subZProbe = await runJS(
      `(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
        for(let i=0;i<60;i++){if(document.querySelector('.ass-overlay canvas')||document.querySelector('.libassjs-canvas'))break;await wait(500)}
        const v=document.querySelector('.art-video')||document.querySelector('video');
        const cv=document.querySelector('.ass-overlay canvas')||document.querySelector('.libassjs-canvas')||document.querySelector('.ass-canvas');
        const cp=document.querySelector('.ass-overlay')||document.querySelector('.libassjs-canvas-parent');
        const hint=document.querySelector('.player-hint');
        const rect=(e)=>{if(!e)return null;const r=e.getBoundingClientRect();const c=getComputedStyle(e);return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),z:c.zIndex,pos:c.position}};
        let maxHits=0,firstHitAt=0,positive=0,err='',hintHit=null;
        if(hint){const r=hint.getBoundingClientRect();const el=document.elementFromPoint(r.left+30,r.top+r.height/2);hintHit=el?(el.closest&&el.closest('.player-hint')?'visible':'covered-by:'+el.tagName):null}
        const t0=Date.now();
        for(let i=0;i<200;i++){
          await wait(1000);
          let hits=0;
          if(cv&&Date.now()-t0>15000){try{const ctx=cv.getContext('2d');const d=ctx.getImageData(0,0,cv.width,cv.height).data;for(let k=3;k<d.length;k+=397)if(d[k]>10)hits++}catch(e){if(!err)err=e.message}}
          if(hits>0){positive++;if(!firstHitAt)firstHitAt=i+1}
          maxHits=Math.max(maxHits,hits);
        }
        return JSON.stringify({vw:v?v.videoWidth:0,video:rect(v),canvas:rect(cv),canvasParent:rect(cp),hint:rect(hint),hintHit,maxHits,positive,firstHitSec:firstHitAt,err})})()`,
      240000
    )
    log('subZProbe ' + subZProbe)
    console.log('[debug] subZProbe', subZProbe)
    // 最坏情况：展开「章节」+「手动标记」面板后再量一次布局
    await runJS(
      `(()=>{const chips=[...document.querySelectorAll('.sub-bar.skip-bar .sub-chip')];for(const c of chips){const t=c.innerText||'';if(t.includes('章节')||t.includes('手动标记'))c.click()}return chips.length})()`
    )
    await sleep(1500)
    const layoutProbe = await runJS(
      `(()=>{const box=(e)=>{if(!e)return null;const r=e.getBoundingClientRect();return {h:Math.round(r.height),top:Math.round(r.top),bottom:Math.round(r.bottom),scrollH:e.scrollHeight}};const bars=[...document.querySelectorAll('.sub-bar')].map(e=>({cls:e.className.replace('sub-bar','').trim(),h:Math.round(e.getBoundingClientRect().height),bottom:Math.round(e.getBoundingClientRect().bottom),top:Math.round(e.getBoundingClientRect().top)}));const wrap=document.querySelector('.player-bars');return JSON.stringify({win:{w:innerWidth,h:innerHeight},stage:box(document.querySelector('.player-stage')),artHost:box(document.querySelector('.art-host')),barsWrap:box(wrap),barsScroll:wrap?wrap.scrollHeight>wrap.clientHeight+1:null,bars,tools:box(document.querySelector('.player-tools')),markPanel:box(document.querySelector('.mark-panel')),chapBar:!!document.querySelector('.chap-bar'),allBarsVisible:bars.every(b=>b.bottom<=innerHeight+1)})})()`,
      4000
    )
    log('layoutProbe ' + layoutProbe)
    console.log('[debug] layoutProbe', layoutProbe)
    console.log('[debug] skipDomProbe', skipProbe)
    await sleep(6000)
    await shot('4-player-late')
    const dump = await runJS(
      `(()=>{const v=document.querySelector('video');const ov=!!document.querySelector('.player-overlay');return JSON.stringify({bodyText:(document.body.innerText||'').replace(/\\n+/g,'|').slice(0,120),rootKids:document.getElementById('root').children.length,overlay:ov,hasVideo:!!v,vid:v?{rs:v.readyState,ns:v.networkState,err:v.error?(v.error.code+':'+v.error.message):null,t:v.currentTime,du:v.duration,playing:!v.paused&&!v.ended&&v.currentTime>0,w:v.videoWidth,h:v.videoHeight}:null,playerHint:(document.querySelector('.player-hint')?.innerText||'').slice(0,120)})})()`
    )
    log('dump ' + dump)
    log('msgs:\n' + msgs.slice(-80).join('\n'))
    console.log('[debug] dump', dump)
    console.log('[debug] msgs\n' + msgs.slice(-80).join('\n'))
  })
}

function registerIpc() {
  ipcMain.handle('dialog:selectDirectory', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled ? null : r.filePaths[0] || null
  })
  ipcMain.handle('dialog:selectFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件',
      properties: ['openFile'],
      filters: [
        { name: '程序', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return r.canceled ? null : r.filePaths[0] || null
  })
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), electron: process.versions.electron }))
  ipcMain.handle('app:quit', () => {
    app.quit()
    return true
  })
}

async function bootstrap() {
  // 启动本地服务（端口占用则自动 +1 重试）
  const baidu = new Baidu()
  const cfgPort = Number(loadConfig().port)
  const base = Number.isInteger(cfgPort) && cfgPort >= 1024 && cfgPort <= 65535 ? cfgPort : 16888
  let started = null
  for (let i = 0; i < 8; i++) {
    try {
      saveConfig({ port: base + i })
      started = await startServer({ baidu })
      break
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') continue
      console.error('服务启动失败：', err)
      app.quit()
      return
    }
  }
  if (!started) {
    console.error('端口全部被占用')
    app.quit()
    return
  }
  serverPort = started.port
  console.log(`[pan-browser] local server ready at http://127.0.0.1:${started.port}`)

  registerIpc()

  if (isHeadless) {
    console.log('[pan-browser] HEADLESS mode: window skipped')
    return
  }
  createMainWindow()
}

app.whenReady().then(() => {
  bootstrap()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !isHeadless) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
