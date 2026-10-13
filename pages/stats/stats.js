// pages/stats/stats.js
const util = require('../../utils/util')
const store = require('../../utils/store')
const charts = require('../../utils/charts')

const PALETTE = charts.PALETTE
const RED_RGB = '242,83,80'
const GREEN_RGB = '69,168,136'

// 分类排行行的公共字段（月报、年报共用），各自再补充环比/同比等对比字段
function baseRow(x, t) {
  return {
    key: x.key,
    icon: x.icon,
    label: x.label,
    count: x.count,
    percentText: x.percent.toFixed(1),
    totalText: (t === 'expense' ? '-' : '+') + util.money(x.total),
    amtCls: t === 'expense' ? 'd-red' : 'd-green',
    bar: x.bar
  }
}

// 取前 n 项，其余合并为「其他」
function topN(agg, n) {
  const top = agg.list.slice(0, n).map(x => ({ label: x.label, value: x.total }))
  const rest = agg.list.slice(n)
  if (rest.length) top.push({ label: '其他', value: Math.round(rest.reduce((s, x) => s + x.total, 0) * 100) / 100 })
  return top
}

// 汇总卡展开区：3 列 × 5 行，文案与顺序对齐设计稿，字段名对应 store.periodStats
const MORE_ROWS = [
  ['日均支出', 'avgExpense'], ['日均收入', 'avgIncome'], ['日均结余', 'avgBalance'],
  ['转账', 'transfer'], ['还款', 'repay'], ['收款', 'collect'],
  ['应付/借入', 'borrow'], ['应收/借出', 'lend'], ['手续费', 'fee'],
  ['报销', 'reimburse'], ['报销到账', 'reimbursed'], ['待报销', 'reimbursePending'],
  ['退款', 'refund'], ['退款收入', 'refundIncome'], ['退款支出', 'refundExpense']
]

// 汇总卡数据：首行 3 项常显（金额按收支配色），其余 15 项折叠
function sumCard(s, prefix) {
  return {
    top: [
      { label: prefix + '支出', value: util.moneyThou(s.expense), cls: 'd-red' },
      { label: prefix + '收入', value: util.moneyThou(s.income), cls: 'd-green' },
      { label: prefix + '结余', value: util.moneyThou(s.balance), cls: s.balance < 0 ? 'd-red' : 'd-green' }
    ],
    more: MORE_ROWS.map(r => ({ label: r[0], value: util.moneyThou(s[r[1]]) }))
  }
}

// ---------------- 资产走势 / 收支走势（DOM 折线图，与「收支统计」柱状图同一套做法） ----------------
// 这两张图原来用 canvas 画，但 canvas 是原生组件：页面滚动、汇总卡折叠这类布局动画时它不跟手；
// 改成图片显示又要经过异步取图、会晚一拍。所以和柱状图一样用普通 view + CSS 画：
// 一条线 = 面积图层（渐变 + clip-path 裁形状）+ 折线图层，各占一个 view，点再多也不会撑出几百个节点。
// 坐标都在下面的 rpx 空间里算（绘图区 = 卡片内容宽 650rpx - 纵轴 58rpx），再换算成百分比给 clip-path。
const TA = { w: 592, h: 300, lw: 4, miter: 2.2 }

const { taSeries } = require('../../utils/linechart').create(TA)

// 资产走势：每日净资产，纵轴 5 等分（与柱状图每 25% 一条网格线对齐）
function areaChart(values, labels) {
  if (!values.length) return { on: false }
  const vs = values.length === 1 ? values.concat(values) : values
  let min = Math.min.apply(null, vs)
  let max = Math.max.apply(null, vs)
  if (min === max) { min -= Math.abs(min) || 1; max += Math.abs(max) || 1 }
  const pad = (max - min) * 0.12
  min -= pad
  max += pad
  const yOf = v => TA.h * (1 - (v - min) / (max - min))
  const xOf = i => TA.w * i / (vs.length - 1)
  const s = taSeries(vs.map((v, i) => [xOf(i), yOf(v)]), '69,168,136', 0.20, 0.02, 0)
  const y = [0, 1, 2, 3, 4].map(k => ({
    k, t: charts.compact(max - (max - min) * k / 4), top: Math.round(TA.h * k / 4)
  }))
  const x = []
  labels.forEach((t, i) => {
    if (t) x.push({ k: i, t, cls: 'ta-xc', style: 'left:' + Math.round(xOf(i)) + 'rpx' })
  })
  return { on: true, y, x, layers: [s.area, s.line] }
}

// 收支走势：每日收入 / 支出两条线，纵轴 0 ~ 最大值的整数刻度、上下各留约 9% 余量
function flowChart(flow) {
  const inc = (flow.income || []).slice()
  const exp = (flow.expense || []).slice()
  const max = Math.max.apply(null, inc.concat(exp, [0]))
  if (!inc.length || max <= 0) return { on: false }
  if (inc.length === 1) { inc.push(inc[0]); exp.push(exp[0]) }
  const step = charts.niceStep(max)
  const top = Math.ceil(max / step - 1e-9) * step
  const yMin = -top * 0.09
  const yMax = top * 1.09
  const yOf = v => TA.h * (1 - (v - yMin) / (yMax - yMin))
  const xOf = i => TA.w * i / (inc.length - 1)
  const pts = arr => arr.map((v, i) => [xOf(i), yOf(v)])
  const y = []
  for (let v = 0; v <= top + 1e-9; v += step) {
    y.push({ k: v, t: charts.compact(Math.round(v * 100) / 100), top: Math.round(yOf(v)) })
  }
  const x = [{ k: 's', t: flow.startLabel, cls: '', style: 'left:0' }]
  if (flow.endLabel && flow.endLabel !== flow.startLabel) {
    x.push({ k: 'e', t: flow.endLabel, cls: '', style: 'right:0' })
  }
  // 绘制顺序与原来 canvas 一致：两条面积先画，两条线后画（收入线盖在最上面）
  const e = taSeries(pts(exp), '242,83,80', 0.10, 0.01, 0)
  const i = taSeries(pts(inc), '70,173,143', 0.36, 0.04, 2)
  return { on: true, y, x, layers: [e.area, i.area, e.line, i.line] }
}

// 环形图数据（CSS conic-gradient）
function makeRing(rawItems, filterSmall) {
  const items = rawItems.filter(x => x.value > 0).sort((a, b) => b.value - a.value)
  const total = items.reduce((s, x) => s + x.value, 0)
  if (!total) return { empty: true, segments: [], bg: '#EEF0F2', totalText: '0.00' }
  let shown = items
  let other = 0
  if (filterSmall) {
    shown = items.filter(x => x.value / total * 100 >= 1)
    other = items.filter(x => x.value / total * 100 < 1).reduce((s, x) => s + x.value, 0)
  }
  const segRaw = shown.map((x, i) => ({
    label: x.label, value: x.value, color: PALETTE[i % PALETTE.length]
  }))
  if (other > 0) segRaw.push({ label: '其他', value: other, color: PALETTE[PALETTE.length - 1] })
  const segments = segRaw.map(s => ({
    label: s.label,
    color: s.color,
    percentText: (s.value / total * 100).toFixed(1),
    valueText: util.money(s.value)
  }))
  let acc = 0
  const parts = segRaw.map(s => {
    const p0 = acc / total * 100
    acc += s.value
    const p1 = acc / total * 100
    return s.color + ' ' + p0.toFixed(2) + '% ' + p1.toFixed(2) + '%'
  })
  return { empty: false, segments, bg: 'conic-gradient(' + parts.join(',') + ')', totalText: util.money(total) }
}

// 按账户汇总某类账单（支出/收入），返回降序 {label,value} 列表
function accountAgg(bills, type) {
  const map = {}
  bills.forEach(b => {
    if (store.flowType(b) !== type) return
    const id = store.accIdOf(b, 'from')
    if (!id) return
    if (!map[id]) {
      const acc = store.getAccount(id)
      map[id] = { label: b.account || (acc ? acc.name : '未知账户'), value: 0 }
    }
    map[id].value += store.billAmount(b)
  })
  return Object.values(map)
    .filter(x => x.value > 0)
    .map(x => ({ label: x.label, value: Math.round(x.value * 100) / 100 }))
    .sort((a, b) => b.value - a.value)
}

// 账户收支环形图数据：与「支出占比」同一套 CSS 环形图（makeRing），占比 < 1% 的账户合并为「其他」
function makeAccountRing(bills, type) {
  return makeRing(accountAgg(bills, type), true)
}

// 金额对比文案：cur 相对 prev
function delta(cur, prev, type) {
  cur = Math.round(cur * 100) / 100
  prev = Math.round(prev * 100) / 100
  if (!prev && !cur) return null
  // prev 极小（小于0.01元）时视为从0开始，避免百分比爆炸
  if (prev < 0.01) {
    if (!cur) return null
    return { text: '新增 ' + charts.compact(cur), cls: type === 'expense' ? 'd-red' : 'd-green' }
  }
  const diff = Math.round((cur - prev) * 100) / 100
  if (!diff) return { text: '持平', cls: 'd-gray' }
  const pct = Math.round(Math.abs(diff) / prev * 100)
  const good = type === 'expense' ? diff < 0 : diff > 0
  return {
    text: (diff > 0 ? '+' : '') + charts.compact(diff) + ' ' + pct + '% ' + (diff > 0 ? '↑' : '↓'),
    cls: good ? 'd-green' : 'd-red'
  }
}

// 桑基某一侧中占比小于 1% 的节点合并为「其他」
function filterSmallSide(side) {
  const total = side.reduce((s, x) => s + x.value, 0)
  if (!total) return side
  const keep = side.filter(x => x.label === '其他' || x.value / total >= 0.01)
  const rest = side.filter(x => x.label !== '其他' && x.value / total < 0.01)
  if (rest.length) {
    const ex = keep.find(x => x.label === '其他')
    const sum = Math.round(rest.reduce((s, x) => s + x.value, 0) * 100) / 100
    if (ex) ex.value = Math.round((ex.value + sum) * 100) / 100
    else keep.push({ label: '其他', value: sum })
  }
  return keep
}

// 柱状图纵轴刻度步长（与收支走势图共用）
const niceStep = charts.niceStep

// 某日期之后全部账单对净资产的累计影响（净资产倒推用）
function netAfter(date) {
  let s = 0
  store.getBillsSync().forEach(b => {
    if (typeof b.date !== 'string' || b.date <= date) return
    s += store.netEffect(b)
  })
  return Math.round(s * 100) / 100
}

// 某一年全部账单
function yearBills(year) {
  const prefix = year + '-'
  return store.getBillsSync().filter(b => typeof b.date === 'string' && b.date.indexOf(prefix) === 0)
}

Page({
  data: {
    tab: 'daily',

    // ---------- 日常 ----------
    weekType: 'expense',
    week: { days: [], totalExpense: '0.00', avgExpense: '0.00', totalIncome: '0.00', avgIncome: '0.00' },
    assetMode: 'assets',
    assetModeText: '总资产',
    assetMenu: false,
    assetFilter: true,
    assetRing: { empty: true, segments: [], bg: '#EEF0F2' },
    assetCenter: '0.00',
    assetDebtText: '',
    tagMonth: { list: [] },

    // ---------- 月统计 ----------
    ym: '',
    monthYear: '',
    monthTabs: [],
    mCard: { top: [], more: [] },
    mTrend: { on: false }, // 资产走势图数据（DOM 折线图）
    sumFold: true, // 汇总卡折叠态（默认折叠）：月 / 年 / 自定义共用（三者同时只有一个可见）
    monthBarType: 'expense',
    monthBars: [],
    monthYAxis: [],
    mSankeyFilter: false,
    mScope: 'major',
    mRingType: 'expense',
    mRing: { empty: true, segments: [], bg: '#EEF0F2' },
    mShowAmt: true,
    mList: [],
    mReport: [],
    mSankeyH: 280,
    mAccType: 'expense',
    mAccRing: { empty: true, segments: [], bg: '#EEF0F2' },
    mAccShowAmt: true,

    // ---------- 年统计 ----------
    year: 0,
    yearTabs: [],
    yCard: { top: [], more: [] },
    yTrend: { on: false }, // 资产走势图数据（DOM 折线图）
    yearBarType: 'expense',
    yearBars: [],
    heatType: 'expense',
    heat: [],
    yScope: 'major',
    ySankeyFilter: false,
    yRingType: 'expense',
    yRing: { empty: true, segments: [], bg: '#EEF0F2' },
    yShowAmt: true,
    yList: [],
    yReport: [],
    yTagRing: { empty: true, segments: [], bg: '#EEF0F2' },
    ySankeyH: 280,
    yAccType: 'expense',
    yAccRing: { empty: true, segments: [], bg: '#EEF0F2' },
    yAccShowAmt: true,

    // ---------- 自定义 ----------
    cStart: '',
    cEnd: '',
    cCard: { top: [], more: [] },
    cFlow: { on: false }, // 收支走势图数据（DOM 折线图）
    cTrend: { on: false }, // 资产走势图数据（DOM 折线图）
    cSankeyH: 280,
    cScope: 'major',
    cSankeyFilter: false,
    cRingType: 'expense',
    cRing: { empty: true, segments: [], bg: '#EEF0F2' },
    cShowAmt: true,
    cList: [],
    cReport: [],
    cAccType: 'expense',
    cAccRing: { empty: true, segments: [], bg: '#EEF0F2' },
    cAccShowAmt: true
  },

  onLoad() {
    const now = new Date()
    this.setData({
      ym: util.monthKey(now.getFullYear(), now.getMonth() + 1),
      year: now.getFullYear(),
      cStart: util.monthKey(now.getFullYear(), now.getMonth() + 1) + '-01',
      cEnd: util.dateStr(now)
    })
    this._charts = { monthSankey: {}, yearSankey: {}, customSankey: {} }
    this.buildDaily()
    this.buildMonth()
    this.buildYear()
    this.buildCustom()
  },

  onShow() {
    if (!this.data.ym) return
    // 只重建当前可见tab，避免不必要的计算
    this._buildCurrent()
    this.afterRender()
  },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  // 按需重建当前tab
  _buildCurrent() {
    const tab = this.data.tab
    if (tab === 'daily') this.buildDaily()
    else if (tab === 'month') this.buildMonth()
    else if (tab === 'year') this.buildYear()
    else if (tab === 'custom') this.buildCustom()
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab }, () => {
      // 切换到未构建过的tab时才构建（用标记判断）
      this._buildCurrent()
      this.afterRender()
    })
  },

  afterRender() {
    // 等待setData渲染完成后再重绘canvas
    wx.nextTick(() => {
      setTimeout(() => this.repaint(), 80)
    })
  },

  // ============================================================ 日常
  buildDaily() {
    // ---- 近7日 ----
    const now = new Date()
    const dayMap = {}
    store.getBillsSync().forEach(b => {
      if (typeof b.date !== 'string') return
      if (!dayMap[b.date]) dayMap[b.date] = { e: 0, i: 0 }
      if (store.flowType(b) === 'expense') dayMap[b.date].e += store.billAmount(b)
      else if (store.flowType(b) === 'income') dayMap[b.date].i += store.billAmount(b)
    })
    const days = []
    let te = 0, ti = 0
    for (let k = 6; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - k)
      const key = util.dateStr(d)
      const m = dayMap[key] || { e: 0, i: 0 }
      te += m.e; ti += m.i
      days.push({
        label: k === 0 ? '今天' : util.WEEK[d.getDay()],
        e: Math.round(m.e * 100) / 100,
        i: Math.round(m.i * 100) / 100
      })
    }
    const type = this.data.weekType
    // 每日数据字段为 e/i；结余为 i-e（可能为负）。不能直接 d[type]（那会恒为 undefined）
    const valOf = d => type === 'expense' ? d.e : type === 'income' ? d.i : (d.i - d.e)
    const vals = days.map(valOf)
    // 结余双向用最大绝对值，其余单向
    const max = type === 'balance'
      ? (Math.max.apply(null, vals.map(Math.abs)) || 1)
      : (Math.max.apply(null, vals) || 1)
    days.forEach((d, di) => {
      const v = vals[di]
      d.valueText = v ? charts.compact(v) : ''
      if (type === 'balance') {
        // 0 轴居中：柱占半区（上限 50%），正/负分别从中线向上/下
        const hp = Math.round(Math.abs(v) / max * 50)
        d.down = v < 0
        d.box = v < 0 ? ('top:50%;height:' + hp + '%') : ('bottom:50%;height:' + hp + '%')
        d.barCls = v < 0 ? 'bar-red' : 'bar-green'
        d.h = hp
      } else {
        const hp = v ? Math.round(v / max * 100) : 0
        d.down = false
        d.box = 'bottom:0;height:' + hp + '%'
        d.barCls = type === 'expense' ? 'bar-red' : 'bar-green'
        d.h = hp
      }
    })
    this.setData({
      week: {
        days,
        totalExpense: util.money(te),
        avgExpense: util.money(te / 7),
        totalIncome: util.money(ti),
        avgIncome: util.money(ti / 7)
      }
    })

    // ---- 资产汇总 ----
    this.buildAssetRing()

    // ---- 标签数据（近一月）----
    const startD = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
    const start = util.dateStr(startD)
    const tmap = {}
    store.getBillsSync().forEach(b => {
      if (!b.tag || b.date < start) return
      if (!tmap[b.tag]) tmap[b.tag] = { tag: b.tag, count: 0, e: 0, i: 0 }
      tmap[b.tag].count++
      if (store.flowType(b) === 'expense') tmap[b.tag].e += store.billAmount(b)
      else if (store.flowType(b) === 'income') tmap[b.tag].i += store.billAmount(b)
    })
    const tagList = Object.values(tmap).sort((a, b) => b.count - a.count).slice(0, 5)
      .map(x => ({
        tag: x.tag, count: x.count,
        eText: util.money(x.e), iText: util.money(x.i)
      }))
    this.setData({ 'tagMonth.list': tagList })
  },

  toggleWeekType(e) {
    this.setData({ weekType: e.currentTarget.dataset.t })
    this.buildDaily()
  },

  buildAssetRing() {
    const views = store.getAccountViews()
    const summary = store.getAssetSummary()
    const mode = this.data.assetMode
    let items = []
    let center = 0
    let debtText = ''
    if (mode === 'assets') {
      items = views.filter(v => v.type !== 'credit' && v.balance > 0)
        .map(v => ({ label: v.name, value: v.balance }))
      center = summary.assets
    } else if (mode === 'net') {
      items = views.filter(v => v.type !== 'credit' && v.balance > 0)
        .map(v => ({ label: v.name, value: v.balance }))
      center = summary.net
      debtText = summary.liability > 0 ? '（总负债 ' + util.money(summary.liability) + '）' : ''
    } else {
      items = views.filter(v => v.balance < 0).map(v => ({ label: v.name, value: -v.balance }))
      center = summary.liability
    }
    const ring = makeRing(items, this.data.assetFilter)
    this.setData({
      assetRing: ring,
      assetCenter: util.money(center),
      assetDebtText: debtText
    })
  },

  openAssetMenu() {
    this.setData({ assetMenu: !this.data.assetMenu })
  },

  pickAssetMode(e) {
    const mode = e.currentTarget.dataset.m
    const text = { assets: '总资产', net: '净资产', liability: '总负债' }[mode]
    this.setData({ assetMode: mode, assetModeText: text, assetMenu: false })
    this.buildAssetRing()
  },

  toggleAssetFilter() {
    this.setData({ assetFilter: !this.data.assetFilter })
    this.buildAssetRing()
  },

  goTags() {
    wx.navigateTo({ url: '/pages/tags/tags' })
  },

  // ============================================================ 月统计
  buildMonthTabs(ym) {
    const now = new Date()
    const tabs = []
    for (let k = 0; k < 12; k++) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1)
      const key = util.monthKey(d.getFullYear(), d.getMonth() + 1)
      const text = k === 0 ? '本月' : k === 1 ? '上月' : (d.getMonth() + 1) + '月'
      tabs.push({ ym: key, text })
    }
    this.setData({ monthTabs: tabs, monthYear: ym.slice(0, 4) + '年' })
  },

  buildMonth() {
    const ym = this.data.ym
    if (!ym) return
    this.buildMonthTabs(ym)
    const [y, m] = ym.split('-').map(Number)
    const dim = util.daysInMonth(y, m)
    const bills = store.monthBills(ym)
    const bySub = this.data.mScope === 'all'
    const t = this.data.mRingType

    // 汇总卡
    this.setData({ mCard: sumCard(store.periodStats(bills, ym + '-01', ym + '-' + util.pad(dim)), '月') })

    // 每日柱状：柱顶不显示金额，金额由左侧纵轴刻度标定；结余为双向（0 轴居中）
    const barType = this.data.monthBarType
    const isBal = barType === 'balance'
    const arrE = new Array(dim).fill(0)
    const arrI = new Array(dim).fill(0)
    bills.forEach(b => {
      const day = Number(b.date.slice(8, 10)) - 1
      if (store.flowType(b) === 'expense') arrE[day] += store.billAmount(b)
      else if (store.flowType(b) === 'income') arrI[day] += store.billAmount(b)
    })
    const arr = isBal ? arrE.map((e, i) => Math.round((arrI[i] - e) * 100) / 100)
      : barType === 'income' ? arrI : arrE
    // 纵轴 5 个刻度，上限取整到好看的数；随数据最大值变化，金额差值自适应
    let top, monthYAxis
    if (isBal) {
      const maxAbs = Math.max.apply(null, arr.map(Math.abs))
      top = Math.ceil(maxAbs / niceStep(maxAbs)) * niceStep(maxAbs)
      monthYAxis = [top, top / 2, 0, -top / 2, -top].map((v, k) => ({ k, t: charts.compact(v) }))
    } else {
      const maxV = Math.max.apply(null, arr)
      top = Math.ceil(maxV / niceStep(maxV)) * niceStep(maxV)
      monthYAxis = [top, top * 0.75, top * 0.5, top * 0.25, 0].map((v, k) => ({ k, t: v ? charts.compact(v) : '0' }))
    }
    const bars = arr.map((v, i) => {
      const base = { day: i + 1, lab: i % 2 === 0 ? String(i + 1) : '' }
      if (!v) return Object.assign(base, { box: '', cls: '', down: false })
      if (isBal) {
        const hp = Math.max(2, Math.round(Math.abs(v) / top * 50))
        return Object.assign(base, {
          box: v > 0 ? ('bottom:50%;height:' + hp + '%') : ('top:50%;height:' + hp + '%'),
          cls: v > 0 ? 'bar-green' : 'bar-red', down: v < 0
        })
      }
      const hp = Math.max(3, Math.round(v / top * 100))
      return Object.assign(base, {
        box: 'bottom:0;height:' + hp + '%',
        cls: barType === 'expense' ? 'bar-red' : 'bar-green', down: false
      })
    })
    this.setData({ monthBars: bars, monthYAxis })

    // 资产走势（每日末净资产，倒推）
    const now = new Date()
    const isCur = now.getFullYear() === y && now.getMonth() + 1 === m
    const endDay = isCur ? now.getDate() : dim
    const dayBal = new Array(dim + 1).fill(0)
    bills.forEach(b => {
      const day = Number(b.date.slice(8, 10))
      dayBal[day] += store.netEffect(b)
    })
    const netNow = store.getAssetSummary().net
    const monthEnd = ym + '-' + util.pad(dim)
    const allV = new Array(dim)
    let future = netAfter(monthEnd)
    for (let day = dim; day >= 1; day--) {
      allV[day - 1] = Math.round((netNow - future) * 100) / 100
      future += dayBal[day]
    }
    const values = allV.slice(0, endDay)
    const labels = values.map((_, i) => (i % 2 === 0 ? String(i + 1) : ''))
    this.setData({ mTrend: areaChart(values, labels) })

    // 收支对比（桑基）
    const sankey = {
      incomes: topN(store.categoryStats(bills, 'income', bySub), 5),
      expenses: topN(store.categoryStats(bills, 'expense', bySub), 8)
    }
    if (this.data.mSankeyFilter) {
      sankey.incomes = filterSmallSide(sankey.incomes)
      sankey.expenses = filterSmallSide(sankey.expenses)
    }
    this._charts.monthSankey = sankey
    this.setData({ mSankeyH: charts.sankeyHeight(sankey) })

    // 支出/收入占比（环）
    const ringAgg = store.categoryStats(bills, t, bySub)
    this.setData({ mRing: makeRing(ringAgg.list.map(x => ({ label: x.label, value: x.total })), true) })

    // 支出/收入数据（排行 + 环比/同比）
    const cur = store.categoryStats(bills, t, bySub)
    const lastYM = (() => {
      const d = new Date(y, m - 2, 1)
      return util.monthKey(d.getFullYear(), d.getMonth() + 1)
    })()
    const prevMonthAgg = store.categoryStats(store.monthBills(lastYM), t, bySub)
    const prevYearAgg = store.categoryStats(yearBills(y - 1).filter(b => b.date.slice(5, 7) === util.pad(m)), t, bySub)
    const mList = cur.list.map(x => Object.assign(baseRow(x, t), {
      cmpMo: delta(x.total, prevMonthAgg.byKey[x.key] ? prevMonthAgg.byKey[x.key].total : 0, t),
      cmpMoLabel: '环比上月',
      cmpYr: delta(x.total, prevYearAgg.byKey[x.key] ? prevYearAgg.byKey[x.key].total : 0, t),
      cmpYrLabel: '同比去年'
    }))
    this.setData({ mList })

    // 报表统计（按日）
    const dmap = store.monthDayMap(ym)
    const mReport = Object.values(dmap)
      .filter(d => d.expense || d.income)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map(d => ({
        date: d.date.slice(5),
        e: util.trimZero(util.money(d.expense)),
        i: util.trimZero(util.money(d.income)),
        bal: util.trimZero(util.money(d.income - d.expense)),
        eOn: d.expense > 0,
        iOn: d.income > 0
      }))
    this.setData({ mReport })

    // 账户收支（按账户汇总当月支出/收入）
    this.setData({ mAccRing: makeAccountRing(bills, this.data.mAccType) })
  },

  pickMonthTab(e) {
    const ym = e.currentTarget.dataset.ym
    if (ym === this.data.ym) return
    this.setData({ ym }, () => { this.buildMonth(); this.afterRender() })
  },

  pickMonthYear(e) {
    const v = e.detail.value
    if (!v) return
    this.setData({ ym: v.slice(0, 7) }, () => { this.buildMonth(); this.afterRender() })
  },

  // 展开 / 收起汇总卡：下方的图表卡片要跟着一起平滑滑动。
  // 资产走势 / 收支走势与柱状图一样是普通 view，跟得上；桑基图仍是 canvas，此时可能仍不跟手。
  toggleSumFold() {
    this.setData({ sumFold: !this.data.sumFold })
  },

  toggleMonthBarType(e) {
    this.setData({ monthBarType: e.currentTarget.dataset.t })
    this.buildMonth()
    this.afterRender()
  },

  toggleMScope(e) {
    this.setData({ mScope: e.currentTarget.dataset.s })
    this.buildMonth()
    this.afterRender()
  },

  toggleMSankeyFilter() {
    this.setData({ mSankeyFilter: !this.data.mSankeyFilter })
    this.buildMonth()
    this.afterRender()
  },

  toggleMRing() {
    this.setData({ mRingType: this.data.mRingType === 'expense' ? 'income' : 'expense' })
    this.buildMonth()
  },

  toggleMShowAmt() {
    this.setData({ mShowAmt: !this.data.mShowAmt })
  },

  toggleMAccType(e) {
    this.setData({ mAccType: e.currentTarget.dataset.t })
    this.buildMonth()
  },

  toggleMAccShowAmt() {
    this.setData({ mAccShowAmt: !this.data.mAccShowAmt })
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  // ============================================================ 年统计
  buildYearTabs() {
    // 以真实当前年份为基准固定生成，避免选中往年时列表重排导致
    // 选中项文字错误地显示为「今年」
    const curY = new Date().getFullYear()
    const tabs = []
    for (let k = 0; k < 8; k++) {
      const yy = curY - k
      const text = k === 0 ? '今年' : k === 1 ? '去年' : yy + '年'
      tabs.push({ year: yy, text })
    }
    this.setData({ yearTabs: tabs })
  },

  buildYear() {
    const year = this.data.year
    if (!year) return
    this.buildYearTabs()
    const bills = yearBills(year)
    const bySub = this.data.yScope === 'all'
    const t = this.data.yRingType

    // 按月汇总
    const mE = new Array(12).fill(0)
    const mI = new Array(12).fill(0)
    const mN = new Array(12).fill(0) // 每月对净资产的影响（走势用）
    bills.forEach(b => {
      const m = Number(b.date.slice(5, 7))
      if (store.flowType(b) === 'expense') mE[m - 1] += store.billAmount(b)
      else if (store.flowType(b) === 'income') mI[m - 1] += store.billAmount(b)
      mN[m - 1] += store.netEffect(b)
    })

    // 月柱状（支出/收入/结余）
    const barType = this.data.yearBarType
    const isBal = barType === 'balance'
    const raw = mE.map((e, i) => barType === 'expense' ? e : barType === 'income' ? mI[i] : mI[i] - e)
    const maxAbs = Math.max.apply(null, raw.map(Math.abs)) || 1
    let maxIdx = 0
    raw.forEach((v, i) => { if (Math.abs(v) > Math.abs(raw[maxIdx])) maxIdx = i })
    const yearBars = raw.map((v, i) => {
      const up = isBal ? v >= 0 : true
      return {
        m: i + 1,
        h: v ? Math.max(2, Math.round(Math.abs(v) / maxAbs * (isBal ? 47 : 100))) : 0,
        up,
        valText: v ? charts.compact(v) : '',
        mark: v && i === maxIdx ? charts.compact(v) : '',
        markUp: up
      }
    })

    // 资产走势（每月末净资产）：全年固定 12 个月。
    // 以前按「今年只画到当前月」截断（10 月只有 10 个点），现在整年都画：
    // 当前月之后没有账单，净资产沿用当前值（有预先录入的未来账单则照常计入）。
    const netNow = store.getAssetSummary().net // 只算一次，不放进循环里反复汇总
    let future = netAfter(year + '-12-31')
    const values = new Array(12)
    for (let m = 12; m >= 1; m--) {
      values[m - 1] = Math.round((netNow - future) * 100) / 100
      future += mN[m - 1]
    }
    const labels = values.map((_, i) => String(i + 1))

    // 收支对比（桑基）
    const yearSankey = {
      incomes: topN(store.categoryStats(bills, 'income', bySub), 5),
      expenses: topN(store.categoryStats(bills, 'expense', bySub), 8)
    }
    if (this.data.ySankeyFilter) {
      yearSankey.incomes = filterSmallSide(yearSankey.incomes)
      yearSankey.expenses = filterSmallSide(yearSankey.expenses)
    }
    this._charts.yearSankey = yearSankey

    // 占比环
    const ringAgg = store.categoryStats(bills, t, bySub)

    // 支出/收入数据（对比去年：金额 + 占比百分点）
    const cur = store.categoryStats(bills, t, bySub)
    const prevAgg = store.categoryStats(yearBills(year - 1), t, bySub)
    const yList = cur.list.map(x => {
      const prev = prevAgg.byKey[x.key]
      const prevPct = prev ? prev.percent : 0
      let pp = Math.round((x.percent - prevPct) * 10) / 10
      let ppText = null
      if (prev || x.total) {
        const good = t === 'expense' ? pp < 0 : pp > 0
        ppText = {
          text: '占比' + (pp > 0 ? '+' : '') + pp.toFixed(1) + '个百分点 ' + (pp > 0 ? '↑' : pp < 0 ? '↓' : '—'),
          cls: pp === 0 ? 'd-gray' : good ? 'd-green' : 'd-red'
        }
      }
      return Object.assign(baseRow(x, t), {
        cmpYr: delta(x.total, prev ? prev.total : 0, t),
        cmpYrLabel: '去年同期',
        cmpPp: ppText,
        cmpPpLabel: '环比上年'
      })
    })

    // 报表统计（按月）
    const yReport = []
    for (let m = 12; m >= 1; m--) {
      if (!mE[m - 1] && !mI[m - 1]) continue
      yReport.push({
        date: m + '月',
        e: util.trimZero(util.money(mE[m - 1])),
        i: util.trimZero(util.money(mI[m - 1])),
        bal: util.trimZero(util.money(mI[m - 1] - mE[m - 1])),
        eOn: mE[m - 1] > 0,
        iOn: mI[m - 1] > 0
      })
    }

    // 标签占比（全年有标签支出）
    const tagAgg = {}
    bills.forEach(b => {
      if (store.flowType(b) !== 'expense' || !b.tag) return
      tagAgg[b.tag] = (tagAgg[b.tag] || 0) + store.billAmount(b)
    })
    const tagItems = Object.keys(tagAgg).map(k => ({ label: k, value: tagAgg[k] }))

    // 合并为单次 setData，减少逻辑层→渲染层传输次数
    this.setData({
      yCard: sumCard(store.periodStats(bills, year + '-01-01', year + '-12-31'), '年'),
      yearBars,
      heat: this.buildHeatData(bills, year),
      yTrend: areaChart(values, labels),
      ySankeyH: charts.sankeyHeight(yearSankey),
      yRing: makeRing(ringAgg.list.map(x => ({ label: x.label, value: x.total })), true),
      yList,
      yReport,
      yTagRing: makeRing(tagItems, true),
      yAccRing: makeAccountRing(bills, this.data.yAccType)
    })
  },

  // 收支热力：12 个月点阵（返回数据，由 buildYear 合并 setData）
  buildHeatData(bills, year) {
    const now = new Date()
    const grid = []
    let gmax = 0
    for (let m = 1; m <= 12; m++) {
      const dim = util.daysInMonth(year, m)
      const dayV = new Array(dim).fill(0)
      bills.forEach(b => {
        if (Number(b.date.slice(5, 7)) !== m) return
        const day = Number(b.date.slice(8, 10))
        const type = this.data.heatType
        if (type === 'expense') { if (store.flowType(b) === 'expense') dayV[day - 1] += store.billAmount(b) }
        else if (type === 'income') { if (store.flowType(b) === 'income') dayV[day - 1] += store.billAmount(b) }
        else {
          if (store.flowType(b) === 'income') dayV[day - 1] += store.billAmount(b)
          else if (store.flowType(b) === 'expense') dayV[day - 1] -= store.billAmount(b)
        }
      })
      dayV.forEach(v => { gmax = Math.max(gmax, Math.abs(v)) })
      const first = new Date(year, m - 1, 1).getDay()
      grid.push({ m, dim, first, dayV })
    }
    const type = this.data.heatType
    return grid.map(g => {
      const cells = []
      for (let k = 0; k < g.first; k++) cells.push({ blank: true, key: 'b' + k })
      g.dayV.forEach((v, di) => {
        if (!v) { cells.push({ zero: true, key: 'z' + di }); return }
        const rgb = type === 'expense' ? RED_RGB
          : type === 'income' ? GREEN_RGB
          : v >= 0 ? GREEN_RGB : RED_RGB
        const alpha = 0.15 + 0.8 * Math.abs(v) / (gmax || 1)
        cells.push({ dot: true, key: 'd' + di, style: 'background:rgba(' + rgb + ',' + alpha.toFixed(2) + ')' })
      })
      return {
        label: g.m + '月',
        current: year === now.getFullYear() && g.m === now.getMonth() + 1,
        cells
      }
    })
  },

  pickYearTab(e) {
    const year = Number(e.currentTarget.dataset.year)
    if (year === this.data.year) return
    this.setData({ year }, () => { this.buildYear(); this.afterRender() })
  },

  toggleYearBarType(e) {
    this.setData({ yearBarType: e.currentTarget.dataset.t })
    this.buildYear()
    this.afterRender()
  },

  toggleHeatType(e) {
    this.setData({ heatType: e.currentTarget.dataset.t })
    this.buildYear()
  },

  toggleYScope(e) {
    this.setData({ yScope: e.currentTarget.dataset.s })
    this.buildYear()
    this.afterRender()
  },

  toggleYRing() {
    this.setData({ yRingType: this.data.yRingType === 'expense' ? 'income' : 'expense' })
    this.buildYear()
  },

  toggleYShowAmt() {
    this.setData({ yShowAmt: !this.data.yShowAmt })
  },

  toggleYAccType(e) {
    this.setData({ yAccType: e.currentTarget.dataset.t })
    this.buildYear()
  },

  toggleYAccShowAmt() {
    this.setData({ yAccShowAmt: !this.data.yAccShowAmt })
  },

  toggleYSankeyFilter() {
    this.setData({ ySankeyFilter: !this.data.ySankeyFilter })
    this.buildYear()
    this.afterRender()
  },

  // ============================================================ 自定义统计
  buildCustom() {
    const start = this.data.cStart
    const end = this.data.cEnd
    if (!start || !end || start > end) return

    const sd = new Date(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10))
    const ed = new Date(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10))
    const days = Math.round((ed - sd) / 86400000) + 1
    const all = store.getBillsSync()
    const bills = all.filter(b => typeof b.date === 'string' && b.date >= start && b.date <= end)
    const bySub = this.data.cScope === 'all'
    const t = this.data.cRingType

    // 汇总卡 + 每日收支
    const arrE = new Array(days).fill(0)
    const arrI = new Array(days).fill(0)
    const arrN = new Array(days).fill(0) // 每日对净资产的影响（走势用）
    bills.forEach(b => {
      const di = Math.round((
        new Date(+b.date.slice(0, 4), +b.date.slice(5, 7) - 1, +b.date.slice(8, 10)) - sd
      ) / 86400000)
      if (store.flowType(b) === 'expense') arrE[di] += store.billAmount(b)
      else if (store.flowType(b) === 'income') arrI[di] += store.billAmount(b)
      arrN[di] += store.netEffect(b)
    })
    this.setData({ cCard: sumCard(store.periodStats(bills, start, end), '区间') })

    // 收支走势：每日收入 / 支出两条线（横轴只标起止日期）
    const r2 = v => Math.round(v * 100) / 100
    this.setData({
      cFlow: flowChart({
        income: arrI.map(r2),
        expense: arrE.map(r2),
        startLabel: start.replace(/-/g, '.'),
        endLabel: end.replace(/-/g, '.')
      })
    })

    // 资产走势横轴：日号按天数自适应稀疏
    const labStep = Math.max(1, Math.ceil(days / 15))
    const trendLabels = arrE.map((_, i) => (i % labStep === 0
      ? String(new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + i).getDate()) : ''))

    // 资产走势（范围内每日末净资产，倒推）
    const netNow = store.getAssetSummary().net
    let future = netAfter(end)
    const trendV = new Array(days)
    for (let i = days - 1; i >= 0; i--) {
      trendV[i] = Math.round((netNow - future) * 100) / 100
      future += arrN[i]
    }
    this.setData({ cTrend: areaChart(trendV, trendLabels) })

    // 收支对比（桑基）
    const customSankey = {
      incomes: topN(store.categoryStats(bills, 'income', bySub), 5),
      expenses: topN(store.categoryStats(bills, 'expense', bySub), 8)
    }
    if (this.data.cSankeyFilter) {
      customSankey.incomes = filterSmallSide(customSankey.incomes)
      customSankey.expenses = filterSmallSide(customSankey.expenses)
    }
    this._charts.customSankey = customSankey
    this.setData({ cSankeyH: charts.sankeyHeight(customSankey) })

    // 支出/收入占比（环）
    const ringAgg = store.categoryStats(bills, t, bySub)
    this.setData({ cRing: makeRing(ringAgg.list.map(x => ({ label: x.label, value: x.total })), true) })

    // 支出/收入数据（对比紧邻的等长上期）
    const prevEnd = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() - 1)
    const prevStart = new Date(prevEnd.getFullYear(), prevEnd.getMonth(), prevEnd.getDate() - (days - 1))
    const prevBills = all.filter(b => typeof b.date === 'string'
      && b.date >= util.dateStr(prevStart) && b.date <= util.dateStr(prevEnd))
    const cur = store.categoryStats(bills, t, bySub)
    const prevAgg = store.categoryStats(prevBills, t, bySub)
    const cList = cur.list.map(x => Object.assign(baseRow(x, t), {
      cmpMo: delta(x.total, prevAgg.byKey[x.key] ? prevAgg.byKey[x.key].total : 0, t),
      cmpMoLabel: '对比上期'
    }))
    this.setData({ cList })

    // 报表统计（按日，正序）
    const cReport = []
    for (let i = 0; i < days; i++) {
      if (!arrE[i] && !arrI[i]) continue
      cReport.push({
        date: util.dateStr(new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + i)).slice(5),
        e: util.trimZero(util.money(arrE[i])),
        i: util.trimZero(util.money(arrI[i])),
        bal: util.trimZero(util.money(arrI[i] - arrE[i])),
        eOn: arrE[i] > 0,
        iOn: arrI[i] > 0
      })
    }
    this.setData({ cReport })

    // 账户收支
    this.setData({ cAccRing: makeAccountRing(bills, this.data.cAccType) })
  },

  pickCStart(e) {
    const v = e.detail.value
    if (!v) return
    const patch = { cStart: v }
    if (v > this.data.cEnd) patch.cEnd = v
    this.setData(patch, () => { this.buildCustom(); this.afterRender() })
  },

  pickCEnd(e) {
    const v = e.detail.value
    if (!v) return
    const patch = { cEnd: v }
    if (v < this.data.cStart) patch.cStart = v
    this.setData(patch, () => { this.buildCustom(); this.afterRender() })
  },

  toggleCScope(e) {
    this.setData({ cScope: e.currentTarget.dataset.s })
    this.buildCustom()
    this.afterRender()
  },

  toggleCSankeyFilter() {
    this.setData({ cSankeyFilter: !this.data.cSankeyFilter })
    this.buildCustom()
    this.afterRender()
  },

  toggleCRing() {
    this.setData({ cRingType: this.data.cRingType === 'expense' ? 'income' : 'expense' })
    this.buildCustom()
  },

  toggleCShowAmt() {
    this.setData({ cShowAmt: !this.data.cShowAmt })
  },

  toggleCAccType(e) {
    this.setData({ cAccType: e.currentTarget.dataset.t })
    this.buildCustom()
  },

  toggleCAccShowAmt() {
    this.setData({ cAccShowAmt: !this.data.cAccShowAmt })
  },

  // ============================================================ canvas 重绘
  paint(selector, draw) {
    this.createSelectorQuery().select(selector).fields({ node: true, size: true }).exec(res => {
      const o = res && res[0]
      if (!o || !o.node) return
      const dpr = wx.getWindowInfo().pixelRatio || 2
      o.node.width = o.width * dpr
      o.node.height = o.height * dpr
      const ctx = o.node.getContext('2d')
      ctx.scale(dpr, dpr)
      draw(ctx, o.width, o.height)
    })
  },

  repaint() {
    if (this.data.tab === 'month') {
      this.paint('#monthSankey', (ctx, w, h) => charts.drawSankey(ctx, w, h, this._charts.monthSankey))
    } else if (this.data.tab === 'year') {
      this.paint('#yearSankey', (ctx, w, h) => charts.drawSankey(ctx, w, h, this._charts.yearSankey))
    } else if (this.data.tab === 'custom') {
      this.paint('#customSankey', (ctx, w, h) => charts.drawSankey(ctx, w, h, this._charts.customSankey))
    }
  }
})
