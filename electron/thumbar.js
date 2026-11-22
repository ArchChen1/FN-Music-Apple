// 任务栏缩略图工具栏：鼠标悬停在任务栏图标上时，窗口预览下方显示「上一首 / 播放暂停 / 下一首」。
// 对应 Windows 的 ITaskbarList3 缩略图工具栏，Electron 用 BrowserWindow.setThumbarButtons 暴露；
// 只在 Windows 生效，其他平台静默跳过。
//
// 按钮图标需要 HICON 位图，NativeImage 不支持 SVG，所以仓库里只保留矢量定义（thumbarIcons.js）：
// 主窗口显示后交给渲染进程用 canvas 按各档 DPI 栅格化，再转成 NativeImage 的多表示。
// 任务栏预览的背景跟随 Windows 系统主题（不是应用内主题），深浅两套图形按系统主题选择。
/* global document, Image */
const { nativeTheme, nativeImage } = require('electron')
const { execFileSync } = require('child_process')
const { NAMES, SIZES, COLORS, glyph } = require('./thumbarIcons')
const { coverCard, roundCorners, commit, invalidate, release, watch, appIcon } = require('./thumbnailPreview')

// 在渲染进程里执行：把每个图标、每个 DPI 的 SVG 画到对应尺寸的 canvas，导出 PNG。
// 必须自包含（会以源码字符串注入页面），不能引用本模块的变量。
const RASTERIZE = async (spec) => {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const out = {}
  for (const { name, svgs } of spec) {
    out[name] = {}
    for (const [size, svg] of Object.entries(svgs)) {
      canvas.width = Number(size)
      canvas.height = Number(size)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const img = new Image()
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
      await img.decode()
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      out[name][size] = canvas.toDataURL('image/png')
    }
  }
  return out
}

// 每个图标 × 每档 DPI 的 SVG 源
function specFor(theme) {
  const color = COLORS[theme]
  return NAMES.map((name) => ({
    name,
    svgs: Object.fromEntries(SIZES.map((size) => [String(size), glyph(name, size, color)])),
  }))
}

// 任务栏预览的背景跟随 Windows 系统主题，不能用 nativeTheme.shouldUseDarkColors
// （它跟随应用内的浅色 / 深色设置）。读注册表 SystemUsesLightTheme（0 = 深色），结果缓存，
// 系统主题变化时失效。
let systemDark = null
function systemPrefersDark() {
  if (systemDark !== null) return systemDark
  if (process.platform !== 'win32') return (systemDark = false)
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
    })
    const m = out.match(/SystemUsesLightTheme\s+REG_DWORD\s+(?:0x)?([0-9a-f]+)/i)
    systemDark = m ? Number.parseInt(m[1], 16) === 0 : nativeTheme.shouldUseDarkColors
  } catch {
    systemDark = nativeTheme.shouldUseDarkColors
  }
  return systemDark
}

/**
 * @param {(cmd: string) => void} o.command  发送播放控制命令到渲染进程（toggle / prev / next）
 * @param {(coverId: string) => Promise<Electron.NativeImage | null>} o.coverArt  当前歌曲封面（预览图用大图）
 */
function createThumbar({ command, coverArt }) {
  let target = null
  let player = { title: '', playing: false, coverId: '' }
  let cover = null // 当前封面（大图），null 表示还没有 / 没有封面
  let icon = null // 应用图标，没有封面时铺在预览图上
  let applied = ''
  let previewKey = '' // 已提交的预览图指纹，避免重复合成
  let card = null // 小卡片位图（封面）
  let shot = null // 主窗口界面截图（放大预览用）
  let shotAt = 0 // 上次抓截图的时间，避免连续悬停反复抓
  let liveBuf = null // 上次交出去的放大预览像素，用来判断界面有没有真的变
  let liveCache = null // 由当前这张截图合成的放大预览（切圆角后的像素）
  let liveShot = null // liveCache 对应的截图对象
  let liveTimer = null // 悬停期间每秒截图
  let liveUntil = 0 // 每秒截图跑到什么时候停
  let shotTimer = null // 延迟抓截图（等页面画完、窗口稳定）
  let liveGrabTimer = null // 放大预览落定后再抓新帧，避免扩张动画里重画
  let blankRetry = 0 // 抓到纯色（页面还没画出来）时的重试次数
  let grabbing = false
  let unwatch = null // DWM 消息钩子的拆除函数
  let resizeTimer = null
  const icons = new Map() // theme -> NativeImage 集合
  const pending = new Map() // theme -> 栅格化中的 Promise

  function toIconSet(out) {
    const set = {}
    for (const name of NAMES) {
      const img = nativeImage.createEmpty()
      for (const [size, url] of Object.entries(out?.[name] || {})) {
        const comma = url.indexOf(',')
        const buf = Buffer.from(url.slice(comma + 1), 'base64')
        img.addRepresentation({ scaleFactor: Number(size) / 16, width: 16, height: 16, buffer: buf })
      }
      set[name] = img.isEmpty() ? null : img
    }
    return set
  }

  // 在主窗口里栅格化当前主题的图标；同一主题并发只做一次
  function load(theme) {
    if (icons.has(theme)) return Promise.resolve(icons.get(theme))
    if (pending.has(theme)) return pending.get(theme)
    if (!target || target.isDestroyed()) return Promise.resolve(null)
    const code = `(${RASTERIZE.toString()})(${JSON.stringify(specFor(theme))})`
    const run = target.webContents
      .executeJavaScript(code, true)
      .then((out) => {
        const set = toIconSet(out)
        icons.set(theme, set)
        return set
      })
      .catch((e) => {
        console.error('[thumbar] 图标栅格化失败：', e.message)
        return null
      })
      .finally(() => pending.delete(theme))
    pending.set(theme, run)
    return run
  }

  function apply(buttons, key) {
    if (!target || target.isDestroyed()) return
    try {
      applied = target.setThumbarButtons(buttons) ? key : ''
    } catch (e) {
      applied = ''
      console.error('[thumbar] 设置缩略图工具栏失败：', e.message)
    }
  }

  // ---------- 悬停预览图 ----------
  // 小卡片：当前歌曲封面（保持封面比例，不裁切）；放大预览：窗口真实界面。
  // 放大预览必须是窗口真实像素尺寸的位图，DWM 按 1:1 贴到窗口位置上，
  // 否则（小图）位置和大小都会不对，看起来就像被塞进一个大空框。

  // 小卡片受 DWM 的缩略图尺寸限制（实测 200×120 可用、160×140 就 E_INVALIDARG），封面等比缩进这个盒子
  const THUMB_BOX = { width: 200, height: 120 }
  // 预览里的窗口圆角（DIP），DWM 画图标化预览不套窗口自己的圆角，只能自己切
  const LIVE_RADIUS = 8
  // 悬浮放大时每秒换一张截图，界面动起来才像真的在预览
  const LIVE_INTERVAL = 1000
  // 每次 DWM 来要放大预览，往后延这么多毫秒继续每秒抓
  const LIVE_SPAN = 15000

  function composeCard() {
    const dark = systemPrefersDark()
    card = coverCard(cover, icon || (icon = appIcon()), THUMB_BOX, dark)
  }

  // 放大预览：截图 + 客户区相对窗口左上角的偏移（无边框窗口两者基本重合）。
  // 同一张截图就复用合成结果：DWM 来要图时是同步调用，切圆角 + 拷贝 6MB 像素都要算在里面，
  // 像素没变就不用重做，句柄也能被 commit 复用
  function composeLive() {
    if (!shot) return null
    if (liveCache && liveShot === shot) return liveCache
    const content = target.getContentBounds()
    const bounds = target.getBounds()
    const px = shot.toBitmap()
    const s = shot.getSize()
    // getSize 是 DIP，toBitmap 是设备像素；缩放不是 100% 时按 buffer 还原真实尺寸
    const k = px.length === s.width * s.height * 4 ? 1 : Math.round(Math.sqrt(px.length / 4 / (s.width * s.height)))
    liveShot = shot
    liveCache = {
      image: roundCorners({ width: s.width * k, height: s.height * k, buffer: px }, LIVE_RADIUS * k),
      client: [content.x - bounds.x, content.y - bounds.y],
    }
    return liveCache
  }

  // 交放大预览。内容没变就不交，否则 DWM 每换一张图都会重画一次，看起来就是闪
  function commitLive() {
    const live = composeLive()
    if (!live) return false
    const same = liveBuf && liveBuf.length === live.image.buffer.length && liveBuf.equals(live.image.buffer)
    if (same) return false
    const ok = commit(target, 'live', live.image, live.client)
    if (ok) liveBuf = live.image.buffer
    return ok
  }

  // DWM 来要放大预览时用它。必须当场交出已有的那一帧：交 null 的话 DWM 只能先画一块
  // 空白（用户看到的就是「白闪一下」），等异步截图回来才有图。有旧帧就先给旧帧，
  // 悬停期间每秒抓的新帧会把画面刷新过来。
  function liveForRequest() {
    const live = composeLive()
    if (!live) return null
    liveBuf = live.image.buffer
    return live
  }

  function refreshPreview(force = false) {
    if (process.platform !== 'win32' || !target || target.isDestroyed()) return
    const dark = systemPrefersDark()
    const key = `${player.title ? 'song' : 'idle'}:${player.coverId}:${cover ? 1 : 0}:${dark ? 'd' : 'l'}`
    if (!force && key === previewKey) return
    previewKey = key
    composeCard()
    // 内容变了先让 DWM 丢掉旧图再交新图，否则悬停预览会一直停在上一张。
    // invalidate 会把放大预览那张也丢掉，所以之后必须重新交一次：内容没变的话
    // commitLive 会按去重逻辑跳过，DWM 手里就又是空的，悬停放大只能先画白底
    invalidate(target)
    liveBuf = null
    commit(target, 'thumb', card)
    commitLive()
  }

  // 悬停期间每秒抓一张截图刷新放大预览；DWM 一段时间不来要图就停，别在没人看的时候一直截
  function startLiveLoop() {
    liveUntil = Date.now() + LIVE_SPAN
    if (liveTimer) return
    liveTimer = setInterval(() => {
      if (Date.now() > liveUntil || !target || target.isDestroyed()) {
        stopLiveLoop()
        return
      }
      grabShot(true)
    }, LIVE_INTERVAL)
  }

  function stopLiveLoop() {
    if (liveTimer) clearInterval(liveTimer)
    liveTimer = null
  }

  // 窗口最小化 / 隐藏时渲染进程不再出画面，capturePage 只会拿到空图，
  // 这时候要留住最小化之前那张，悬停还是能看到窗口的样子
  function canCapture() {
    return !!target && !target.isDestroyed() && target.isVisible() && !target.isMinimized()
  }

  // 整张图基本是一个颜色（白屏、全透明、还没画出来的纯色）就别拿去交差，
  // 否则第一次悬停会先看到一张白的，过一秒才换成界面
  function blank(px) {
    const n = px.length
    if (n < 16) return true
    const step = Math.max(4, Math.floor(n / 4 / 8000) * 4) // 抽两万个点左右就够判断
    const ref = [px[0], px[1], px[2]]
    let same = 0
    let total = 0
    for (let i = 0; i + 3 < n; i += step) {
      total++
      if (Math.abs(px[i] - ref[0]) < 3 && Math.abs(px[i + 1] - ref[1]) < 3 && Math.abs(px[i + 2] - ref[2]) < 3) same++
    }
    return total > 0 && same / total > 0.95
  }

  // 抓一张主窗口界面的截图给放大预览用。截图是异步的（DWM 要图时必须当场回图），
  // 所以在悬停小卡片、窗口获得焦点、页面加载完、缩放结束时提前抓好，放大时直接交。
  function grabShot(force = false) {
    if (process.platform !== 'win32' || !target || target.isDestroyed()) return
    if (!canCapture()) return
    if (grabbing || (!force && Date.now() - shotAt < 600)) return
    grabbing = true
    shotAt = Date.now()
    target.webContents
      .capturePage()
      .then((img) => {
        if (!img || img.isEmpty()) return
        // 整张图是纯色（白屏、全透明）说明页面还没画出来，留着上一张，稍后重试
        if (blank(img.toBitmap())) {
          if (blankRetry < 12) {
            blankRetry++
            clearTimeout(shotTimer)
            shotTimer = setTimeout(() => grabShot(true), 800)
          }
          return
        }
        blankRetry = 0
        shot = img
        // 只换放大预览的图；不 invalidate，避免和 DWM 的请求互相触发
        commitLive()
      })
      .catch(() => {})
      .finally(() => { grabbing = false })
  }

  // 换歌时异步取封面（走主进程的封面缓存，和托盘菜单用的是同一套）
  function loadCover(coverId) {
    if (!coverId || !coverArt) {
      cover = null
      refreshPreview(true)
      return
    }
    coverArt(coverId)
      .then((img) => {
        if (player.coverId !== coverId) return // 已经切到别的歌了
        cover = img && !img.isEmpty() ? img : null
        refreshPreview(true)
      })
      .catch(() => {
        if (player.coverId !== coverId) return
        cover = null
        refreshPreview(true)
      })
  }

  // 统一的刷新入口。force=true 用于窗口重建或图标栅格化完成后重新挂按钮
  function sync(force = false) {
    if (process.platform !== 'win32' || !target || target.isDestroyed()) return
    refreshPreview(force)
    const has = !!player.title
    const theme = systemPrefersDark() ? 'dark' : 'light'
    const key = has ? `${theme}:${player.playing ? 'playing' : 'paused'}` : 'idle'
    if (!force && key === applied) return
    if (!has) {
      apply([], 'idle')
      return
    }
    const set = icons.get(theme)
    if (!set) {
      // 首次显示或切换系统主题：图标栅格化完成后会再次进来
      load(theme).then((loaded) => { if (loaded) sync(true) })
      return
    }
    // 图标缺失时宁可不显示，也不要挂几个空白按钮
    if (!set.prev || !set.play || !set.pause || !set.next) return
    apply([
      { icon: set.prev, tooltip: '上一首', click: () => command('prev') },
      { icon: player.playing ? set.pause : set.play, tooltip: player.playing ? '暂停' : '播放', click: () => command('toggle') },
      { icon: set.next, tooltip: '下一首', click: () => command('next') },
    ], key)
  }

  const onThemeUpdated = () => {
    systemDark = null
    sync(true)
  }
  const onResize = () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      refreshPreview(true)
      grabShot()
    }, 250)
  }
  // 窗口状态变化时把截图换成新的，放大预览才不会显示旧界面。
  // 延迟一点再抓：show / did-finish-load 那一刻页面往往还没画完，抓到的是白屏。
  const onRefreshShot = () => {
    clearTimeout(shotTimer)
    shotTimer = setTimeout(() => grabShot(), 350)
  }
  // 最小化 / 还原会改变小卡片该用哪一帧（最小化后用最后画面，还原后回到封面），
  // 必须让 DWM 丢掉缓存的缩略图，否则悬停在最小化的窗口上还是旧卡片
  const onWindowState = () => {
    clearTimeout(shotTimer)
    if (target?.isMinimized()) {
      refreshPreview(true)
      return
    }
    shotTimer = setTimeout(() => {
      sync(true)
      grabShot()
    }, 350)
  }
  nativeTheme.on('updated', onThemeUpdated)

  return {
    // 主窗口显示后把按钮挂到它上面；重建窗口时再次调用即可
    attach(win) {
      target?.removeListener('resize', onResize)
      target?.removeListener('restore', onResize)
      target?.removeListener('restore', onRefreshShot)
      target?.removeListener('show', onRefreshShot)
      target?.removeListener('focus', onRefreshShot)
      target?.removeListener('minimize', onWindowState)
      target?.webContents?.removeListener('did-finish-load', onRefreshShot)
      unwatch?.()
      unwatch = null
      stopLiveLoop()
      clearTimeout(shotTimer)
      clearTimeout(liveGrabTimer)
      if (target && !target.isDestroyed()) release(target)
      target = win
      // 换了窗口，旧的卡片和截图都不再代表它
      card = null
      shot = null
      shotAt = 0
      liveCache = null
      liveShot = null
      liveBuf = null
      previewKey = ''
      // 窗口大小 / 状态变了预览图要重来（防抖：拖拽缩放手势期间不反复合成）
      win.on('resize', onResize)
      win.on('restore', onResize)
      win.on('restore', onRefreshShot)
      win.on('show', onRefreshShot)
      win.on('focus', onRefreshShot)
      win.on('minimize', onWindowState)
      win.webContents.on('did-finish-load', onRefreshShot)
      // DWM 悬停时会来要图：小卡片要封面，放大预览要窗口界面的截图
      unwatch = watch(win, {
        thumb: () => card,
        live: () => liveForRequest(),
        onRequest: (kind) => {
          startLiveLoop()
          if (kind === 'thumb') {
            // 悬停那一刻就抓一张最新的，别拿窗口刚打开时那张（那时候页面还没画出来，是白的）
            if (!shot || Date.now() - shotAt > 1000) grabShot(true)
            // 小卡片一出现就先把放大预览那张塞给 DWM：从卡片放大起来时才不用等我们
            // 回消息，否则 DWM 手里没图，扩张动画先是一块白底，就是那下白闪。
            // 去重标记清掉强制再交一次，DWM 上一次预览结束可能已经把那张丢了
            liveBuf = null
            commitLive()
            grabShot(true)
            return
          }
          // 放大预览这一刻不要立刻重新截图：新帧在扩张动画里提交会让 DWM 整块重画一次，
          // 看起来又是一下闪；等动画落定再换成新的实时画面
          if (!shot) {
            grabShot(true)
            return
          }
          clearTimeout(liveGrabTimer)
          liveGrabTimer = setTimeout(() => grabShot(true), 700)
        },
      })
      sync(true)
      // 等页面画出来再抓第一张，窗口刚显示时抓到的是白屏
      clearTimeout(shotTimer)
      shotTimer = setTimeout(() => grabShot(true), 800)
      if (player.coverId && !cover) loadCover(player.coverId)
    },
    setPlayer(p) {
      const next = { title: String(p?.title || ''), playing: !!p?.playing, coverId: String(p?.coverId || '') }
      if (next.title === player.title && next.playing === player.playing && next.coverId === player.coverId) return
      const coverChanged = next.coverId !== player.coverId
      player = next
      if (coverChanged) {
        cover = null
        loadCover(next.coverId)
      }
      sync()
    },
    destroy() {
      nativeTheme.removeListener('updated', onThemeUpdated)
      target?.removeListener('resize', onResize)
      target?.removeListener('restore', onResize)
      target?.removeListener('restore', onRefreshShot)
      target?.removeListener('show', onRefreshShot)
      target?.removeListener('focus', onRefreshShot)
      target?.webContents?.removeListener('did-finish-load', onRefreshShot)
      clearTimeout(resizeTimer)
      clearTimeout(shotTimer)
      clearTimeout(liveGrabTimer)
      unwatch?.()
      unwatch = null
      stopLiveLoop()
      card = null
      shot = null
      liveBuf = null
      liveCache = null
      liveShot = null
      if (target && !target.isDestroyed()) release(target)
      target = null
    },
  }
}

module.exports = { createThumbar }
