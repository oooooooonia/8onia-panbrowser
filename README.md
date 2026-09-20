# PanBrowser · 个人百度网盘挂载浏览器（类 alist，Electron）

本地自用桌面应用：仿照 music downloader（Electron + electron-vite + React）构建，
只挂载 **百度网盘** 一个存储，提供类 alist 的文件浏览、**网页内原画在线播放**与 **PotPlayer 拉起播放**。

> 首次启动为**未登录**状态：仓库内不内置任何账号凭证，需在设置页手动填写开放平台凭证，
> 或从本机 AList 的 `data.db` 一键导入。

## 功能

- **挂载百度网盘**：凭证可一键从本机正在运行的 AList `data.db`（driver=`BaiduNetdisk`）只读导入，也可手动填写开放平台凭证
- **原画在线播放**：内置 **ArtPlayer**（类 alist）；本地服务在请求百度 dlink 时携带请求头
  `User-Agent: pan.baidu.com`（>20MB 文件必须，否则 403），并透传 `Range` 支持拖动进度，
  页面播放器直接播放源文件 = 原画
- **同目录字幕（alist 同款渲染）**：自动发现视频同目录字幕（srt / ass / ssa / vtt）并**内容嗅探真实格式**。
  - ASS/SSA → 引入 **libass-wasm(SubtitlesOctopus)** 在独立 canvas 按 ASS 规范渲染，**坐标、颜色、边框、字体与特效全还原**（自动使用本机 CJK 字体兜底，如 msyh.ttc）
  - VTT/SRT → 走播放器原生字幕轨道（VTT 位置/对齐保留）
  - 字幕可一键切换、单独下载；`.ass` 实为 vtt 等“扩展名与内容不符”的文件也能正确分流
- **PotPlayer 播放**：浏览器不能解码的编码（H.265/HEVC、AC3 等）一键交给 PotPlayer 播放同一原画流
- **跳过片头片尾（OP/ED）**：三层信号自动定位，播放器右下角浮出「跳过 OP」按钮，进度条上高亮 OP/ED 区间，可在设置里开自动跳过
- **下载 / 复制直链**：下载同样带 UA 代理；"原画直链"给出带 `curl -H "User-Agent: pan.baidu.com"` 的命令
- 深色、无 emoji、lucide 图标，**手机应用式响应式布局**（底部导航，窄屏自适应）

## 跳过 OP/ED 是怎么定位的

番剧的 OP 常常不在片头（冷开场之后才播），单靠一种手段都不可靠，所以按置信度分层：

| 优先级 | 数据源 | 手段 | 实测效果 |
| --- | --- | --- | --- |
| 1 | **手动标记** | 播放器里以当前播放位置打点，可只作用于本集或整个剧集 | 100% 可靠，兜底方案 |
| 2 | **章节（打标）** | `ffprobe -show_chapters`，先按名字识别 `OP/NCOP/Opening/ED/NCED/Ending/Intro/Preview`，名字无信息时按「60~130s 独立章节 + 位置」推断 | 秒级返回；标注文件精确到帧，未标注文件靠结构推断 |
| 3 | **字幕** | ASS 样式名（`OPJP/EDCN`…）聚成歌词块 + 外挂字幕跨集重复文本；内嵌字幕**复用**播放器为显示字幕而抽取的结果（零额外带宽，绝不并行再抽一遍，避免和字幕加载抢带宽） | 秒级；字幕加载完成后自动补检 |

实测样本（带章节标注的番剧文件）：
- 章节名明确写 `OP`：直接命中（`OP 139.10→230.02`）
- 冷开场之后才播 OP：只有 `Intro/Part A/Part B/ED/Preview`，OP 藏在 213s 的 Intro 里 → 自动检测不到，界面会给出提示，用手动标记
- 通用章节名 `Chapter 01..05`：靠 91s/90s 结构推断出 `OP 0→91`、`ED 1322→1412`
- 无可用章节名：靠结构推断出冷开场后的 `OP 105→195`

播放器内：进度条上 OP/ED 区间染色；进入区间时右下角浮出「跳过片头 · 剩余 xx」；设置页可开「自动跳过 OP/ED」并设置延迟秒数。检测结果按文件缓存（`userData/skip-cache.json`），手动标记存 `userData/skip-marks.json`，优先级最高。

> 说明：跳过只对内置网页播放器生效，PotPlayer/mpv/VLC 不受影响。

## 技术要点（对齐 AList 百度驱动官方接口）

| 用途 | 请求 |
| --- | --- |
| 刷新令牌 | `GET openapi.baidu.com/oauth/2.0/token?grant_type=refresh_token&...` |
| 列表 | `GET pan.baidu.com/rest/2.0/xpan/file?method=list&dir=...&start=0&limit=200`（翻页） |
| 取 dlink | `GET pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=[id]&dlink=1` |
| 下载/流 | `dlink&access_token=...` → 携带 `User-Agent: pan.baidu.com` 跟随重定向后 Range 流式传输 |
| 账户 | `GET pan.baidu.com/rest/2.0/xpan/nas?method=uinfo` |

## 开发 / 运行

```bash
npm install
npm run dev     # 开发模式（热更新）
npm run build   # 构建到 out/
npm start       # 预览构建产物
npm run dist    # 打包 Windows 安装包（可选）
```

首次启动为**未登录**状态（仓库内不内置任何账号凭证）。首次使用：应用设置页 →「从 AList 导入凭证」填入你的
AList 数据目录（含 data.db，如 `C:\Users\<你的用户名>\AList\data`）→ 扫描 → 导入；
也可在设置页手动填写开放平台 `client_id / client_secret / refresh_token`。随后设置页会显示账号与会员状态。

> 注意：百度 `refresh_token` 是一次性令牌（每次刷新会轮换）。若与正在运行的 AList 共用同一
> 令牌，AList 刷新会把它消耗掉；遇到“refresh token has been used”时，在 AList 存储设置里
> 重新保存一次该存储（持久化最新令牌）或停止 AList 后再导入，也可在设置页手动粘贴最新令牌。
> 应用已内置容错：持有有效 access_token 时不会主动刷新，只有接口返回 401 才刷新。

PotPlayer 路径默认自动检测常见安装位置，找不到可在设置里手动指定
`PotPlayerMini64.exe`。

> 想在没有图形界面时预置凭证：把 `resources/default-config.example.json` 复制为
> `resources/default-config.json` 并填好字段（该文件已被 `.gitignore` 忽略，不会被提交）。
> 留空即保持未登录。

## 本地服务

主进程内置 HTTP 服务（默认 `127.0.0.1:16888`）。桌面窗口即访问该地址；
如需手机访问同一局域网，设置页开启 `0.0.0.0` 监听后重启（个人内网使用，注意暴露范围）。

## 播放稳定性与诊断（0.1.1）

**过去的问题**：偶尔「卡在一个地方不动」，不报错，只能刷新页面——根因是本地流代理把上游连接弄断后
**没有把客户端那条响应收尾**：响应头已带 `content-length`，字节却停在半截，浏览器 `<video>` 会无限等待
（既不触发 `error`，也不会自愈）。触发条件是出现「30 秒没有一个字节」的空窗：暂停、缓冲满了浏览器
停止读取、百度 CDN 抖动，以及首次打开内嵌字幕视频时服务端 ffmpeg 全量抽字幕轨抢带宽。

0.1.1 的处理：

| 层 | 改动 |
| --- | --- |
| 流代理 | 上游 `error/aborted/未读完就关闭` 一律立刻结束客户端响应（`res.destroy()`+上游 `destroy()`），让播放器拿到明确中断 |
| 超时策略 | 30s 只用于「建连+响应头」；流式阶段改为软看门狗，只有「既无字节、也无客户端背压」才判死（阈值 5 分钟，避免误杀暂停中的播放） |
| 直链 | 上游 401/403/404/410/416/5xx 时刷新 dlink 重试一次（直链有有效期，缓存过期后旧链接会被作废） |
| 前端 | `waiting/stalled` 后 8s 无进度推进（或 `networkState=NO_SOURCE`）→ 记住断点 `load()` 重连续播，最多 3 次；`MEDIA_ERR_NETWORK` 走同一路径而不再误报「编码不支持」；断流重连不再重复挂载 libass 画布 |

出问题时的诊断：主进程会把断流原因写进**项目根目录** `.debug/log.txt`，形如
`stream abort upstream-close-incomplete bytes=… ms=… range="bytes=…" path=…`；
渲染层的关键事件（选字幕/挂 libass/自愈重连）通过 `/api/debug/log` 写同一个文件。
复现/回归脚本：`_probe/stall-test.mjs`（上游静默 / 客户端背压 / 直链重试四组场景）、
`_probe/e2e-server.ps1`（起真实主进程验 `/api/stream` 不挂起）。

## 免责声明

仅供个人学习与交流。所有文件版权归权利人所有；本项目不存储任何文件，仅作百度网盘
官方接口的个人客户端封装，接口随百度调整可能失效。

> 提示：嵌入式 Chromium 解码能力有限——H.265/HEVC、AC3 等编码无法在网页播放器解码（这是浏览器限制，与字幕无关）。此类原画建议用「PotPlayer 播放」（已验证）。另外数 GB 级原画流播放时 Chromium 浏览器进程会占用较高 CPU，属环境行为。
