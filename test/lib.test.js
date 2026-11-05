import { describe, expect, it } from 'vitest'
import { fmtTime, fmtTotal, parseLrc, pickRandom, shuffled, stripSourceTitle } from '../src/lib.js'

describe('fmtTime', () => {
  it.each([[0, '0:00'], [5.9, '0:05'], [65, '1:05'], [3600, '60:00'], [-3, '0:00'], [NaN, '0:00'], [Infinity, '0:00']])('%s → %s', (s, out) => expect(fmtTime(s)).toBe(out))
})

describe('fmtTotal', () => {
  it('不足一小时', () => expect(fmtTotal(42 * 60)).toBe('42 分钟'))
  it('超过一小时', () => expect(fmtTotal(125 * 60)).toBe('2 小时 5 分钟'))
})

describe('parseLrc', () => {
  it('空文本', () => expect(parseLrc('')).toEqual([]))
  it('解析时间戳与歌词，忽略元数据行', () => {
    const lines = parseLrc('[ti:标题]\n[00:01.50]第一行\r\n[00:03.123]第二行\n无时间戳')
    expect(lines).toEqual([{ time: 1.5, text: '第一行' }, { time: 3.123, text: '第二行' }])
  })
  it('一行多个时间戳会展开并按时间排序', () => {
    const lines = parseLrc('[00:10.00][00:02.00]副歌\n[00:05.00]主歌')
    expect(lines.map((l) => [l.time, l.text])).toEqual([[2, '副歌'], [5, '主歌'], [10, '副歌']])
  })
  it('支持 [mm:ss] 与 [mm:ss:xx] 写法', () => {
    expect(parseLrc('[01:02]a\n[01:03:50]b').map((l) => l.time)).toEqual([62, 63.5])
  })
  it('应用 offset（毫秒，正值表示歌词提前）', () => {
    expect(parseLrc('[offset:500]\n[00:02.00]a')[0].time).toBeCloseTo(1.5)
  })
  it('去掉行内的逐字时间标签', () => {
    expect(parseLrc('[00:01.00]你<00:01.20>好')[0].text).toBe('你<00:01.20>好')
    expect(parseLrc('[00:01.00]你[00:01.20]好')[0].text).toBe('你好')
  })
})

describe('stripSourceTitle', () => {
  it('剥掉 fnmusic-ext 的固定来源标记，保留原始歌名', () => {
    expect(stripSourceTitle('[music box] 稻香')).toBe('稻香')
    expect(stripSourceTitle('[dl] 晴天')).toBe('晴天')
    expect(stripSourceTitle('[lx] 夜曲')).toBe('夜曲')
  })

  it('支持 VIP / 来源叠加，以及洛雪动态脚本-平台标记', () => {
    expect(stripSourceTitle('[VIP] 新歌')).toBe('新歌')
    expect(stripSourceTitle('[music box] [VIP] 新歌')).toBe('新歌')
    expect(stripSourceTitle('[墨澜-kg] 晴天')).toBe('晴天')
    expect(stripSourceTitle('[云海源-kw] [VIP] 七里香')).toBe('七里香')
  })

  it('只精确剥已知来源，不误伤歌名自己的方括号或未知脚本平台', () => {
    expect(stripSourceTitle('[Live] 晴天')).toBe('[Live] 晴天')
    expect(stripSourceTitle('歌名 [demo]')).toBe('歌名 [demo]')
    expect(stripSourceTitle('[未知脚本-xx] 晴天')).toBe('[未知脚本-xx] 晴天')
  })
})

describe('shuffled / pickRandom', () => {
  it('不修改原数组且元素不变', () => {
    const a = Array.from({ length: 50 }, (_, i) => i)
    const b = shuffled(a)
    expect(a).toEqual(Array.from({ length: 50 }, (_, i) => i))
    expect([...b].sort((x, y) => x - y)).toEqual(a)
  })
  it('pickRandom 取指定数量且不重复', () => {
    const r = pickRandom([1, 2, 3, 4, 5], 3)
    expect(r).toHaveLength(3)
    expect(new Set(r).size).toBe(3)
  })
})
