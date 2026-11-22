// 任务栏悬停预览：小卡片（任务栏缩略图）显示当前歌曲封面，保持封面自己的比例、不裁切；
// 没有歌曲（常见于空播放列表）时显示应用图标。鼠标再放到卡片上放大时显示窗口真实界面。
//
// Windows 没有「设置缩略图」的 API，只能走 DWM 的图标化表示：声明 DWMWA_HAS_ICONIC_BITMAP +
// DWMWA_FORCE_ICONIC_REPRESENTATION 后，悬停时会收到 WM_DWMSENDICONICTHUMBNAIL（小卡片）和
// WM_DWMSENDICONICLIVEPREVIEWBITMAP（放大预览），当场用 DwmSetIconicThumbnail /
// DwmSetIconicLivePreviewBitmap 交 32bpp DIB。只声明前者时 DWM 仍显示窗口本体，不用我们的图。
// DWM 只接受来自拥有窗口的进程的位图，所以只能用 koffi 在主进程直调系统 DLL。
const path = require('path')
const { nativeImage } = require('electron')

const isWin = process.platform === 'win32'

const DWMWA_FORCE_ICONIC_REPRESENTATION = 7
const DWMWA_HAS_ICONIC_BITMAP = 10

let api = null
// koffi 与系统 DLL 只在 Windows 上加载，其他平台整块跳过
function dwm() {
  if (!isWin) return null
  if (api) return api
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  const HWND = koffi.pointer('HWND', koffi.opaque()) // 声明一次，函数原型里按名字引用
  koffi.pointer('HDC', koffi.opaque())
  koffi.pointer('HBITMAP', koffi.opaque())
  const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t', biBitCount: 'uint16_t',
    biCompression: 'uint32_t', biSizeImage: 'uint32_t', biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t',
    biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
  })
  const RGBQUAD = koffi.struct('RGBQUAD', { rgbBlue: 'uint8_t', rgbGreen: 'uint8_t', rgbRed: 'uint8_t', rgbReserved: 'uint8_t' })
  const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array(RGBQUAD, 1) })
  api = {
    HWND,
    koffi,
    GetDC: user32.func('HDC __stdcall GetDC(HWND hWnd)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(HWND hWnd, HDC hDC)'),
    CreateDIBSection: gdi32.func('HBITMAP __stdcall CreateDIBSection(HDC hdc, const BITMAPINFO *pbmi, uint32_t usage, _Out_ void **ppvBits, void *hSection, uint32_t dwOffset)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(void *ho)'),
    DwmSetWindowAttribute: dwmapi.func('int __stdcall DwmSetWindowAttribute(HWND hwnd, uint32_t dwAttribute, const void *pvAttribute, uint32_t cbAttribute)'),
    DwmSetIconicThumbnail: dwmapi.func('int __stdcall DwmSetIconicThumbnail(HWND hwnd, HBITMAP hbmp, uint32_t dwSITFlags)'),
    DwmSetIconicLivePreviewBitmap: dwmapi.func('int __stdcall DwmSetIconicLivePreviewBitmap(HWND hwnd, HBITMAP hbmp, const int32_t *pptClient, uint32_t dwSITFlags)'),
    DwmInvalidateIconicBitmaps: dwmapi.func('int __stdcall DwmInvalidateIconicBitmaps(HWND hwnd)'),
    BITMAPINFO,
  }
  return api
}

// ---------- 位图合成 ----------

// 深色底：卡片空位（竖版封面按比例缩进盒子后两侧留白）用它兜底
const BASE = [30, 30, 32]

function canvas(w, h, base = BASE) {
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = base[2]
    out[i * 4 + 1] = base[1]
    out[i * 4 + 2] = base[0]
    out[i * 4 + 3] = 255
  }
  return out
}

// 把源图像素按 alpha 叠到画布上（BGRA 直通，不预乘）
function blit(out, dstW, dstH, src, srcW, srcH, x0, y0) {
  for (let y = 0; y < srcH; y++) {
    const dy = y0 + y
    if (dy < 0 || dy >= dstH) continue
    for (let x = 0; x < srcW; x++) {
      const dx = x0 + x
      if (dx < 0 || dx >= dstW) continue
      const si = (y * srcW + x) * 4
      const di = (dy * dstW + dx) * 4
      const a = src[si + 3] / 255
      if (a === 1) {
        out[di] = src[si]
        out[di + 1] = src[si + 1]
        out[di + 2] = src[si + 2]
        continue
      }
      if (!a) continue
      out[di] = Math.round(src[si] * a + out[di] * (1 - a))
      out[di + 1] = Math.round(src[si + 1] * a + out[di + 1] * (1 - a))
      out[di + 2] = Math.round(src[si + 2] * a + out[di + 2] * (1 - a))
    }
  }
}

const usable = (img) => !!img && !img.isEmpty()

/**
 * 小卡片：封面按自己的比例缩放到给定范围内（长边不超 box，不裁切）；
 * 没有封面时纯色底 + 居中应用图标。
 * DWM 对任务栏缩略图有尺寸上限（实测 200×120 可用、160×140 已 E_INVALIDARG），所以按盒子等比缩。
 * @returns {{width: number, height: number, buffer: Buffer}}
 */
function coverCard(cover, icon, box = { width: 200, height: 120 }, dark = true) {
  if (usable(cover)) {
    const s = cover.getSize()
    const k = Math.min(box.width / s.width, box.height / s.height)
    const width = Math.max(2, Math.round(s.width * k))
    const height = Math.max(2, Math.round(s.height * k))
    return { width, height, buffer: cover.resize({ width, height, quality: 'best' }).toBitmap() }
  }
  // 无歌曲：纯色卡片 + 居中图标
  const width = box.width
  const height = box.height
  const out = canvas(width, height, dark ? BASE : [242, 242, 246])
  if (usable(icon)) {
    const s = icon.getSize()
    const k = Math.min((width * 0.5) / s.width, (height * 0.5) / s.height)
    const iw = Math.max(1, Math.round(s.width * k))
    const ih = Math.max(1, Math.round(s.height * k))
    blit(out, width, height, icon.resize({ width: iw, height: ih, quality: 'best' }).toBitmap(), iw, ih, Math.round((width - iw) / 2), Math.round((height - ih) / 2))
  }
  return { width, height, buffer: out }
}

// ---------- 提交给 DWM ----------

function hwndOf(win) {
  return Buffer.from(win.getNativeWindowHandle()).readBigUInt64LE(0)
}

// 把 BGRA 像素做成 32bpp 自顶向下的 DIB
function toHBitmap(w, h, bgra) {
  const d = dwm()
  const hdc = d.GetDC(null)
  const bits = [null]
  const hbmp = d.CreateDIBSection(hdc, {
    bmiHeader: {
      biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0,
      biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    },
    bmiColors: [{ rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 }],
  }, 0, bits, null, 0)
  d.ReleaseDC(null, hdc)
  if (!hbmp || !bits[0]) return null
  d.koffi.encode(bits[0], 'uint8_t', bgra, Math.min(bgra.length, w * h * 4))
  return hbmp
}

const marked = new WeakSet() // 已声明过「自己画预览图」的窗口
// 窗口 -> 已经建好的 DIB 句柄（同一份像素复用，避免在 DWM 的同步回调里重建大位图）
const dibCache = new WeakMap()
const pendingDelete = [] // DWM 复制完再释放，避免提交瞬间被回收

function flushDeletes() {
  const d = dwm()
  for (const h of pendingDelete.splice(0)) {
    try { d.DeleteObject(h) } catch {}
  }
}

// NativeImage 的 getSize 是 DIP、toBitmap 是设备像素，缩放不是 100% 时两者对不上。
// 以 buffer 长度为准还原真实像素宽高，DWM 要的是位图的真实尺寸。
function pixels(image) {
  const width = image.width
  const height = image.height
  const n = image.buffer.length / 4
  if (n === width * height) return { width, height, k: 1 }
  const k = Math.round(Math.sqrt(n / (width * height)))
  if (k > 1 && n === width * k * height * k) return { width: width * k, height: height * k, k }
  return { width, height, k: 1 }
}

/**
 * 把预览位图交给 DWM。which：'thumb' 悬停小卡片（封面，尺寸受限）；'live' 放大预览（窗口截图）。
 * live 的 client 是客户区相对窗口左上角的偏移，DWM 按 1:1 把这图摆在窗口的位置上，
 * 尺寸取窗口真实像素尺寸，看起来才和原窗口一致。
 * 两个属性必须一起声明：只声明 HAS_ICONIC_BITMAP 时，带重定向表面的窗口仍会显示窗口本体，
 * DWM 不用我们给的图。
 * @returns {boolean} 是否提交成功
 */
function commit(win, which, image, client = null) {
  const d = dwm()
  if (!d || !win || win.isDestroyed() || !image) return false
  const isThumb = which === 'thumb'
  try {
    const hwnd = hwndOf(win)
    if (!marked.has(win)) {
      const attr = d.koffi.alloc('uint8_t', 4)
      d.koffi.encode(attr, 'uint8_t', Buffer.from([1, 0, 0, 0]), 4)
      d.DwmSetWindowAttribute(hwnd, DWMWA_HAS_ICONIC_BITMAP, attr, 4)
      d.DwmSetWindowAttribute(hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, attr, 4)
      marked.add(win)
    }
    const px = pixels(image)
    // DWM 来要图时必须当场交，这段是同步执行的：重建一张 1600×1000 的 DIB 要分配 + 拷贝
    // 约 6MB，慢的时候 DWM 已经先把白底画出来了。同样的像素就复用上一张 DIB，只做一次
    // DwmSet* 调用，把这段耗时压到最小。
    const entry = dibCache.get(win) || {}
    const slot = isThumb ? 'thumb' : 'live'
    const cached = entry[slot]
    let hbmp
    if (cached && cached.buf === image.buffer) hbmp = cached.h
    else {
      hbmp = toHBitmap(px.width, px.height, image.buffer)
      if (cached) pendingDelete.push(cached.h)
      entry[slot] = { buf: image.buffer, h: hbmp }
      dibCache.set(win, entry)
    }
    if (!hbmp) return false
    const pt = client ? new Int32Array([Math.round(client[0] * px.k), Math.round(client[1] * px.k)]) : null
    const hr = isThumb
      ? d.DwmSetIconicThumbnail(hwnd, hbmp, 0)
      : d.DwmSetIconicLivePreviewBitmap(hwnd, hbmp, pt, 0)
    if (hr !== 0) console.error('[thumb-preview] 提交预览图失败', which, `${px.width}x${px.height}`, 'HRESULT=0x' + (hr >>> 0).toString(16))
    setTimeout(flushDeletes, 1000)
    return hr === 0
  } catch (e) {
    console.error('[thumb-preview] 提交任务栏预览失败：', e.message)
    return false
  }
}

// 通知 DWM 已交的图过期了，它会重新向窗口要图（配合 watch 的钩子才会立刻换图）
function invalidate(win) {
  const d = dwm()
  if (!d || !win || win.isDestroyed()) return
  try { d.DwmInvalidateIconicBitmaps(hwndOf(win)) } catch {}
}

// 窗口不要了：把复用的 DIB 句柄排进删除队列，别让 GDI 对象挂在那儿
function release(win) {
  const entry = dibCache.get(win)
  if (!entry) return
  for (const slot of ['thumb', 'live']) if (entry[slot]?.h) pendingDelete.push(entry[slot].h)
  dibCache.delete(win)
  setTimeout(flushDeletes, 1000)
}

// DWM 在要小卡片 / 放大预览时分别向窗口发这两条消息，必须当场回图
const WM_DWMSENDICONICTHUMBNAIL = 0x0323
const WM_DWMSENDICONICLIVEPREVIEWBITMAP = 0x0326

/**
 * 挂上 DWM 的「要预览图」消息钩子，悬停任务栏图标和放大卡片时当场回图。
 * @param {Electron.BrowserWindow} win
 * @param {{thumb: () => object|null, live: () => {image: object, client: number[]}|null, onRequest?: (kind: 'thumb'|'live') => void}} o
 * @returns {() => void} 拆除钩子
 */
function watch(win, { thumb, live, onRequest }) {
  if (!dwm() || !win || typeof win.hookWindowMessage !== 'function') return () => {}
  const make = (kind) => () => {
    try {
      onRequest?.(kind)
      if (kind === 'thumb') {
        commit(win, 'thumb', thumb())
        return
      }
      const l = live?.()
      if (l) commit(win, 'live', l.image, l.client)
    } catch (e) {
      console.error('[thumb-preview] 响应 DWM 请求失败：', e.message)
    }
  }
  const a = make('thumb')
  const b = make('live')
  try {
    win.hookWindowMessage(WM_DWMSENDICONICTHUMBNAIL, a)
    win.hookWindowMessage(WM_DWMSENDICONICLIVEPREVIEWBITMAP, b)
  } catch (e) {
    console.error('[thumb-preview] 消息钩子挂载失败：', e.message)
  }
  return () => {
    try {
      win.unhookWindowMessage(WM_DWMSENDICONICTHUMBNAIL)
      win.unhookWindowMessage(WM_DWMSENDICONICLIVEPREVIEWBITMAP)
    } catch {}
  }
}

function appIcon() {
  return nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))
}

/**
 * 把位图四角切成圆角（改 alpha，带 1px 抗锯齿）。DWM 画图标化预览时不套窗口自己的圆角，
 * 不自己切就是一块方角，和真正的窗口对不上。
 * @param {{width: number, height: number, buffer: Buffer}} image
 * @param {number} radius 像素半径
 */
function roundCorners(image, radius) {
  const { width, height, buffer } = image
  const r = Math.round(radius)
  if (r < 1 || width < 2 * r || height < 2 * r) return image
  const out = Buffer.from(buffer)
  const set = (x, y, cov) => {
    const i = (y * width + x) * 4
    out[i + 3] = Math.round(out[i + 3] * cov)
  }
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < r; x++) {
      const d = Math.hypot(r - x - 0.5, r - y - 0.5) // 像素中心到圆心
      const cov = Math.min(1, Math.max(0, r - d + 0.5))
      set(x, y, cov)
      set(width - 1 - x, y, cov)
      set(x, height - 1 - y, cov)
      set(width - 1 - x, height - 1 - y, cov)
    }
  }
  return { width, height, buffer: out }
}

module.exports = { coverCard, roundCorners, commit, invalidate, release, watch, appIcon, isWin }
