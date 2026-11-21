import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// thumbnailPreview 只用到 NativeImage 的 getSize / isEmpty / resize / crop / toBitmap，
// 单测里用假图代替，不依赖 Electron 本体
const { coverCard, roundCorners } = require('../electron/thumbnailPreview')

function fakeImage(w, h, [b, g, r]) {
  const px = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = b
    px[i * 4 + 1] = g
    px[i * 4 + 2] = r
    px[i * 4 + 3] = 255
  }
  const img = {
    getSize: () => ({ width: w, height: h }),
    isEmpty: () => false,
    resize: ({ width, height }) => fakeImage(width, height, [b, g, r]),
    crop: ({ width, height }) => fakeImage(width, height, [b, g, r]),
    toBitmap: () => px,
  }
  return img
}

const at = (buf, w, x, y) => {
  const i = (y * w + x) * 4
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
}

describe('任务栏预览图合成', () => {
  it('小卡片用封面自己的比例缩进 200×120 的盒子，不裁切', () => {
    const card = coverCard(fakeImage(100, 140, [0, 0, 255]), null, { width: 200, height: 120 })
    expect(card.height).toBe(120)
    expect(card.width).toBe(86) // 100/140 × 120
    expect(card.buffer.length).toBe(card.width * card.height * 4)
    expect(at(card.buffer, card.width, 0, 0)).toEqual([0, 0, 255, 255])
  })

  it('横版封面受宽度限制', () => {
    const card = coverCard(fakeImage(400, 100, [0, 0, 255]), null, { width: 200, height: 120 })
    expect(card.width).toBe(200)
    expect(card.height).toBe(50)
  })

  it('没有歌曲时小卡片是 200×120 的纯色卡片 + 居中图标', () => {
    const icon = fakeImage(64, 64, [0, 0, 255])
    const card = coverCard(null, icon, { width: 200, height: 120 }, true)
    expect(card.width).toBe(200)
    expect(card.height).toBe(120)
    expect(at(card.buffer, card.width, 2, 2)).toEqual([32, 30, 30, 255])
    expect(at(card.buffer, card.width, card.width / 2, card.height / 2)).toEqual([0, 0, 255, 255])
  })

  it('浅色系统主题下没有歌曲的卡片用浅底色', () => {
    const card = coverCard(null, fakeImage(64, 64, [0, 0, 255]), { width: 200, height: 120 }, false)
    expect(at(card.buffer, card.width, 20, 20)).toEqual([246, 242, 242, 255])
  })
})

describe('放大预览的圆角', () => {
  it('四角透明、中间不透明', () => {
    const img = { width: 200, height: 120, buffer: fakeImage(200, 120, [10, 10, 10]).toBitmap() }
    const out = roundCorners(img, 8)
    expect(at(out.buffer, 200, 0, 0)[3]).toBe(0)
    expect(at(out.buffer, 200, 199, 0)[3]).toBe(0)
    expect(at(out.buffer, 200, 0, 119)[3]).toBe(0)
    expect(at(out.buffer, 200, 199, 119)[3]).toBe(0)
    expect(at(out.buffer, 200, 100, 60)[3]).toBe(255)
    expect(at(out.buffer, 200, 10, 10)[3]).toBe(255)
  })

  it('半径过大时原样返回，不改尺寸和颜色', () => {
    const img = { width: 10, height: 10, buffer: fakeImage(10, 10, [1, 2, 3]).toBitmap() }
    const out = roundCorners(img, 8)
    expect(out.buffer.length).toBe(img.buffer.length)
    expect(at(out.buffer, 10, 0, 0)).toEqual([1, 2, 3, 255])
  })
})
