// utils/charts.js
// 统计页 canvas 图表：收支对比（桑基图）。
// 资产走势 / 收支走势已改为 DOM 折线图（见 pages/stats），不再用 canvas。
// 纯绘制函数，由页面传入 2d canvas 的 ctx 与 CSS 像素尺寸。
// （账户收支的环形图与「支出占比」共用页面里的 CSS 环形图 + 图例，不再用 canvas 绘制。）

const GREEN = '#45A888'
const RED = '#F25350'

// 环形图 / 分类色板
const PALETTE = [
  '#15B8B4', '#F2904D', '#F6D94F', '#86DCD2', '#D8F2A2',
  '#F8D98A', '#F2A7C3', '#EF86B4', '#A78CFA', '#7AB8F2', '#B7BFC4'
]

// 紧凑金额：12345 -> '1.23万'，否则两位小数去尾零
function compact(n) {
  n = Number(n) || 0
  const neg = n < 0
  n = Math.abs(n)
  let s
  if (n >= 10000) {
    s = (n / 10000).toFixed(2).replace(/\.?0+$/, '') + '万'
  } else if (n >= 1000) {
    s = Math.round(n).toLocaleString('en-US')
  } else {
    s = (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '')
  }
  return (neg ? '-' : '') + s
}


// 千分位 + 两位小数：11199 -> '11,199.00'（桑基图标签用，与设计稿一致）
function fmt2(n) {
  n = Math.round((Number(n) || 0) * 100) / 100
  const parts = n.toFixed(2).split('.')
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1]
}

// 纵轴刻度步长：把最大值分成约 4 段，取 1/2/2.5/5/10 ×10^n，使刻度为整数
function niceStep(max) {
  if (!max || max <= 0) return 1
  const raw = max / 4
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / p
  const mult = n < 1.5 ? 1 : n < 2.25 ? 2 : n < 3.75 ? 2.5 : n < 7.5 ? 5 : 10
  return mult * p
}

// 带状连接：源竖边 -> 目标竖边（三次贝塞尔闭合填充）
function ribbon(ctx, xs, ys0, ys1, xt, yt0, yt1, color) {
  const mx = (xs + xt) / 2
  ctx.beginPath()
  ctx.moveTo(xs, ys0)
  ctx.bezierCurveTo(mx, ys0, mx, yt0, xt, yt0)
  ctx.lineTo(xt, yt1)
  ctx.bezierCurveTo(mx, yt1, mx, ys1, xs, ys1)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

// ------------------------------------------------------------ 收支对比（桑基）
// opt: { incomes:[{label,value}], expenses:[{label,value}] }
//
// 版式（参照设计稿）：
//   左：收入来源节点 ──▶ 「收入」柱 ──▶ 「支出」柱 ──▶ 右：支出分类节点
//   收入 > 支出：收入柱下半段引向右下角「结余」（斜线填充）
//   支出 > 收入：左下角「超支」（斜线填充）引入支出柱下半段
// 两根柱子同一比例尺（较大者固定 BAR 高）；左/右节点只有「最小高度 + 按占比增量」，
// 缎带在柱子一侧按真实占比取宽、在节点一侧取节点高度，所以小额分类呈扇形展开。
const SN = '#65A994'                   // 收入侧（节点/柱/文字）
const SR = '#E8615B'                   // 支出侧
const SN_FLOW = 'rgba(101,169,148,0.38)'
const SR_FLOW = 'rgba(232,97,91,0.38)'
const SK = {
  BAR: 96,     // 较大一根柱的高度
  NODE_W: 7,   // 左右节点宽
  BAR_W: 9,    // 中间柱宽
  GAP: 3.5,    // 相邻节点最小间隙
  ROW: 14,     // 相邻节点中心的最小间距（保证标签不重叠）
  SEP: 14,     // 结余 / 超支节点与其余节点的间距
  MIN_H: 5,    // 节点最小高度
  HEAD: 28,    // 顶部「收入 / 支出」标题占高
  PAD_B: 16
}

// 竖直堆叠：第一个节点顶端为 0，返回总高度
function stackY(nodes) {
  let prevC = 0
  let ext = 0
  nodes.forEach((n, i) => {
    const c = i === 0 ? n.h / 2 : prevC + Math.max(SK.ROW, (nodes[i - 1].h + n.h) / 2 + SK.GAP)
    n.y = c - n.h / 2
    prevC = c
    ext = n.y + n.h
  })
  return ext
}

// 与宽度无关的纵向模型：y 均相对「柱顶」（柱顶 = 0），最后统一平移出标题位
function sankeyModel(opt) {
  const clean = list => (list || [])
    .filter(x => x && x.value > 0)
    .map(x => ({ label: x.label, value: x.value }))
    .sort((a, b) => b.value - a.value)
  const incomes = clean(opt.incomes)
  const expenses = clean(opt.expenses)
  const totalIn = incomes.reduce((s, x) => s + x.value, 0)
  const totalOut = expenses.reduce((s, x) => s + x.value, 0)
  const M = Math.max(totalIn, totalOut)
  if (!(M > 0)) return null

  const k = SK.BAR / M
  const hIn = totalIn * k
  const hOut = totalOut * k
  const diff = Math.round((totalIn - totalOut) * 100) / 100
  const surplus = diff > 0 ? diff : 0
  const deficit = diff < 0 ? -diff : 0

  // 左列：收入来源 + 超支。收入节点合计高度 = 收入柱高：每个节点先保底 minL，余量按占比分配，
  // 这样「理财盈利」这类小额来源也有清晰可见的节点，缎带在柱侧仍按真实占比收窄
  const nIn = incomes.length
  const minL = Math.min(22, hIn / Math.max(1, nIn) * 0.5)
  const left = incomes.map(x => Object.assign(x, { h: minL + x.value / totalIn * (hIn - nIn * minL) }))
  const lExt = stackY(left)
  const lOff = left.length ? hIn / 2 - lExt / 2 : 0
  left.forEach(n => { n.y += lOff })
  let defNode = null
  if (deficit > 0) {
    defNode = { label: '超支', value: deficit, h: Math.max(SK.MIN_H, deficit * k) }
    defNode.y = left.length ? lOff + lExt + SK.SEP : 0
  }

  // 右列：支出分类（最小高度 + 占比增量，居中对齐支出柱）+ 结余
  const right = expenses.map(x => Object.assign(x, {
    h: SK.MIN_H + x.value / totalOut * 0.5 * hOut
  }))
  const rExt = stackY(right)
  const rOff = right.length ? hOut / 2 - rExt / 2 : 0
  right.forEach(n => { n.y += rOff })
  let surNode = null
  if (surplus > 0) {
    surNode = { label: '结余', value: surplus, h: Math.max(SK.MIN_H, surplus * k) }
    surNode.y = right.length ? rOff + rExt + SK.SEP : 0
  }

  // 整体平移：最高处留出标题
  const all = left.concat(right, defNode || [], surNode || [])
  const minTop = Math.min.apply(null, [0].concat(all.map(n => n.y)))
  const maxBot = Math.max.apply(null, [hIn, hOut].concat(all.map(n => n.y + n.h)))
  const shift = SK.HEAD - minTop
  return {
    left, right, defNode, surNode, k, hIn, hOut, totalIn, totalOut, surplus, deficit,
    shift, H: shift + maxBot + SK.PAD_B
  }
}

// 画布所需高度（页面据此设置 canvas 高度）
function sankeyHeight(opt) {
  const m = sankeyModel(opt || {})
  return m ? Math.max(150, Math.ceil(m.H)) : 150
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// 斜线填充节点（结余 / 超支）：浅底 + 45° 细斜线
function hatchNode(ctx, x, y, w, h, rgb) {
  ctx.save()
  roundRect(ctx, x, y, w, h, 1.5)
  ctx.clip()
  ctx.fillStyle = 'rgba(' + rgb + ',0.16)'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = 'rgba(' + rgb + ',0.85)'
  ctx.lineWidth = 1.1
  ctx.beginPath()
  for (let i = -h; i < w + 3; i += 3.2) {
    ctx.moveTo(x + i, y + h)
    ctx.lineTo(x + i + h, y)
  }
  ctx.stroke()
  ctx.restore()
}

// 「名称 + 金额」标签：名称过长时只截断名称，金额始终完整
function fitLabel(ctx, name, amount, nameFirst, maxW) {
  const sep = '  '
  const rest = maxW - ctx.measureText(amount + sep).width
  let n = String(name)
  if (ctx.measureText(n).width > rest) {
    let t = n
    while (t.length > 1 && ctx.measureText(t + '…').width > rest) t = t.slice(0, -1)
    n = rest > ctx.measureText('…').width * 2 ? t + '…' : ''
  }
  if (!n) return amount
  return nameFirst ? n + sep + amount : amount + sep + n
}

function drawSankey(ctx, w, h, opt) {
  ctx.clearRect(0, 0, w, h)
  const m = sankeyModel(opt || {})
  if (!m) {
    ctx.fillStyle = '#B3B9BF'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('暂无记录', w / 2, h / 2)
    return
  }

  const fs = Math.max(9, Math.min(10.5, w / 37))
  const { NODE_W, BAR_W } = SK
  const nxL = Math.round(w * 0.235)
  const x1 = Math.round(w * 0.385)
  const x2 = x1 + BAR_W + Math.round(w * 0.095)
  const nxR = Math.round(w * 0.66)
  const Y = v => m.shift + v   // 模型 y -> 画布 y
  const k = m.k

  // ---- 缎带（先画，柱/节点盖在上面）
  // 收入来源 -> 收入柱
  let cum = 0
  m.left.forEach(n => {
    ribbon(ctx, nxL + NODE_W, Y(n.y), Y(n.y + n.h), x1, Y(cum), Y(cum + n.value * k), SN_FLOW)
    cum += n.value * k
  })
  // 超支 -> 支出柱下半段
  if (m.defNode) {
    const d = m.defNode
    ribbon(ctx, nxL + NODE_W, Y(d.y), Y(d.y + d.h), x2, Y(m.hIn), Y(m.hOut), SR_FLOW)
  }
  // 收入柱 -> 支出柱（共同部分，贴顶对齐）
  const common = Math.min(m.totalIn, m.totalOut) * k
  if (common > 0) {
    ribbon(ctx, x1 + BAR_W, Y(0), Y(common), x2, Y(0), Y(common), SR_FLOW)
  }
  // 收入柱下半段 -> 结余
  if (m.surNode) {
    const sN = m.surNode
    ribbon(ctx, x1 + BAR_W, Y(m.hOut), Y(m.hIn), nxR, Y(sN.y), Y(sN.y + sN.h), SN_FLOW)
  }
  // 支出柱 -> 支出分类节点
  cum = 0
  m.right.forEach(n => {
    ribbon(ctx, x2 + BAR_W, Y(cum), Y(cum + n.value * k), nxR, Y(n.y), Y(n.y + n.h), SR_FLOW)
    cum += n.value * k
  })

  // ---- 柱与节点
  if (m.hIn > 0) { ctx.fillStyle = SN; roundRect(ctx, x1, Y(0), BAR_W, m.hIn, 2.5); ctx.fill() }
  if (m.hOut > 0) { ctx.fillStyle = SR; roundRect(ctx, x2, Y(0), BAR_W, m.hOut, 2.5); ctx.fill() }
  m.left.forEach(n => { ctx.fillStyle = SN; roundRect(ctx, nxL, Y(n.y), NODE_W, n.h, 1.5); ctx.fill() })
  m.right.forEach(n => { ctx.fillStyle = SR; roundRect(ctx, nxR, Y(n.y), NODE_W, n.h, 1.5); ctx.fill() })
  if (m.defNode) hatchNode(ctx, nxL, Y(m.defNode.y), NODE_W, m.defNode.h, '232,97,91')
  if (m.surNode) hatchNode(ctx, nxR, Y(m.surNode.y), NODE_W, m.surNode.h, '101,169,148')

  // ---- 标题：收入 / 支出
  ctx.font = (fs + 1.5) + 'px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (m.hIn > 0) { ctx.fillStyle = SN; ctx.fillText('收入', x1 + BAR_W / 2, SK.HEAD / 2) }
  if (m.hOut > 0) { ctx.fillStyle = SR; ctx.fillText('支出', x2 + BAR_W / 2, SK.HEAD / 2) }

  // ---- 标签
  ctx.font = fs + 'px sans-serif'
  ctx.textBaseline = 'middle'
  // 左：收入来源「金额 名称」、超支「超支 金额」，右对齐到节点左侧
  ctx.textAlign = 'right'
  const lMax = nxL - 8
  ctx.fillStyle = SN
  m.left.forEach(n => {
    ctx.fillText(fitLabel(ctx, n.label, fmt2(n.value), false, lMax), nxL - 6, Y(n.y + n.h / 2))
  })
  if (m.defNode) {
    const d = m.defNode
    ctx.fillStyle = SR
    ctx.fillText(fitLabel(ctx, d.label, fmt2(d.value), true, lMax), nxL - 6, Y(d.y + d.h / 2))
  }
  // 右：支出分类「名称 金额」、结余「结余 金额」，左对齐到节点右侧
  ctx.textAlign = 'left'
  const rMax = w - (nxR + NODE_W + 6) - 2
  ctx.fillStyle = SR
  m.right.forEach(n => {
    ctx.fillText(fitLabel(ctx, n.label, fmt2(n.value), true, rMax), nxR + NODE_W + 6, Y(n.y + n.h / 2))
  })
  if (m.surNode) {
    const sN = m.surNode
    ctx.fillStyle = SN
    ctx.fillText(fitLabel(ctx, sN.label, fmt2(sN.value), true, rMax), nxR + NODE_W + 6, Y(sN.y + sN.h / 2))
  }
}

// 纵轴刻度步长：把 range 分成约 n 段，取 {1,1.5,2,2.5,3,4,5,6,8,10}×10^k 里不小于 range/n 的最小值
// （1500 分 5 段 → 300，与「预算趋势」设计稿的 0 / 300 / … / 1,500 一致）
function niceStepN(range, n) {
  if (!range || range <= 0) return 1
  const raw = range / (n || 5)
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / p
  const mult = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(m => m >= f - 1e-9) || 10
  return mult * p
}

module.exports = { GREEN, RED, PALETTE, compact, fmt2, niceStep, niceStepN, drawSankey, sankeyHeight }
