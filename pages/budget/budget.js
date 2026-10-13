// pages/budget/budget.js
const util = require('../../utils/util')
const store = require('../../utils/store')
const charts = require('../../utils/charts')

// ---------------- 预算趋势（DOM 折线图，与统计页走势图同一套做法，见 utils/linechart.js） ----------------
// 绘图区 = hero 卡片内容宽 638rpx - 纵轴 74rpx - 右侧留白 12rpx = 552rpx，高 160rpx；
// BT 常量与 budget.wxss 里 .bt-main / .bt-plot 的尺寸必须同步改。
const BT = { w: 552, h: 160, lw: 4, miter: 2.2 }
const bt = require('../../utils/linechart').create(BT)

// 千分位整数：1500 -> '1,500'
function thou(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// 单调三次插值（Fritsch–Carlson，横向等间距）：只在数值发生变化的相邻两天之间补点（每段 8 个），
// 平直段保持直线、台阶处是平滑的 S 形过渡，且不会冲出极值。折线工具只认折线，所以把曲线采样成折线。
function smooth(pts, sub) {
  const n = pts.length
  if (n < 3) return pts
  const d = []
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]))
  const m = new Array(n)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : 2 * d[i - 1] * d[i] / (d[i - 1] + d[i])
  }
  const out = [pts[0]]
  for (let i = 0; i < n - 1; i++) {
    const x0 = pts[i][0]
    const y0 = pts[i][1]
    const y1 = pts[i + 1][1]
    if (Math.abs(y1 - y0) > 0.01) {
      const hx = pts[i + 1][0] - x0
      const lo = Math.min(y0, y1)
      const hi = Math.max(y0, y1)
      for (let k = 1; k < sub; k++) {
        const t = k / sub
        const t2 = t * t
        const t3 = t2 * t
        const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * hx * m[i] +
          (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * hx * m[i + 1]
        out.push([x0 + t * hx, Math.max(lo, Math.min(hi, y))])
      }
    }
    out.push(pts[i + 1])
  }
  return out
}

// 逐日「累计支出 / 剩余预算」→ 视图数据：纵轴 0 ~ 预算（含超出部分）的整齐刻度，横轴逐 2 天一个日号
function budgetChart(tr) {
  if (!(tr.budget > 0)) return { on: false, msg: '设置预算后显示预算趋势' }
  if (!tr.last) return { on: false, msg: '该月尚未开始' }
  // 趋势线延伸至月底：未来日期保持当前累计值，使线条不在当前日期中断
  const extendArr = (arr, last, dim) => {
    const out = arr.slice(0, last)
    const v = out.length ? out[out.length - 1] : 0
    while (out.length < dim) out.push(v)
    return out
  }
  const spent = extendArr(tr.spent, tr.last, tr.dim)
  const left = extendArr(tr.left, tr.last, tr.dim)
  const max = Math.max.apply(null, [tr.budget].concat(spent))
  const min = Math.min.apply(null, [0].concat(left)) // 超支时剩余为负，纵轴向下延伸
  const step = charts.niceStepN(max - min, 5)
  const top = Math.ceil(max / step - 1e-9) * step
  const lo = Math.floor(min / step + 1e-9) * step
  const yOf = v => BT.h * (1 - (v - lo) / (top - lo))
  const xOf = i => BT.w * i / Math.max(tr.dim - 1, 1)
  const pts = arr => {
    const p = arr.map((v, i) => [xOf(i), yOf(v)])
    if (p.length === 1) p.push([p[0][0] + 1, p[0][1]]) // 只有 1 天数据：画一个小端点
    return smooth(p, 8)
  }
  const y = []
  for (let v = lo; v <= top + 1e-9; v += step) {
    y.push({ k: v, t: thou(v), top: Math.round(yOf(v)) })
  }
  const x = []
  for (let d = 1; d <= tr.dim; d += 2) {
    x.push({ k: d, t: String(d), style: 'left:' + Math.round(xOf(d - 1)) + 'rpx' })
  }
  // 先画两块面积再画两条线（剩余线盖在最上面）
  const red = bt.taSeries(pts(spent), '242,83,80', 0.12, 0.01, 0)
  const green = bt.taSeries(pts(left), '69,168,136', 0.30, 0.02, 2)
  return { on: true, y, x, layers: [red.area, green.area, red.line, green.line] }
}

Page({
  data: {
    mode: 'month', // month | period

    // ---- 月度：每月预算（默认）+ 可选的具体月份覆盖 ----
    ym: '',
    monthTitle: '',
    defaultBudget: '',   // 每月预算（默认值），对所有未单独设置的月份生效
    monthOverride: '',   // 本月单独设置的预算；留空表示使用默认值
    hasOverride: false,
    spent: '0.00',
    left: '0.00',
    trend: { on: false, msg: '' },
    carry: false,
    overcut: false,

    // ---- 特定周期 ----
    periods: [],
    periodSheet: false,
    periodEditId: '',
    periodName: '',
    periodStart: '',
    periodEnd: '',
    periodAmount: ''
  },

  onLoad() {
    const now = new Date()
    this.setData({
      ym: util.monthKey(now.getFullYear(), now.getMonth() + 1)
    })
    const conf = store.getBudgetConf()
    this.setData({
      carry: conf.carry,
      overcut: conf.overcut
    })
    this.loadMonth()
    this.loadPeriods()
  },

  onShow() {
    // 订阅账单 / 预算的变化：账单在别处被改、云同步在后台拉回数据时，趋势图和数字立刻跟着重算，
    // 不再只在页面刚打开 / 保存时算一次。
    if (!this._unwatch) this._unwatch = store.subscribe(() => this.scheduleRefresh())
    // 每次显示都重算（含第一次）：旧写法用 _shown 跳过首次，从其它页返回前的快照可能已过期
    this.refreshData()
    this._shown = true
  },

  unwatch() {
    clearTimeout(this._refreshTimer)
    if (this._unwatch) { this._unwatch(); this._unwatch = null }
  },

  // 连续写入（如一次保存里改多个设置、同步一批账单）合并成一次刷新
  scheduleRefresh() {
    clearTimeout(this._refreshTimer)
    this._refreshTimer = setTimeout(() => this.refreshData(), 80)
  },

  // 重新读取最新数据。用户正在编辑输入框（尚未保存）时只刷新统计和趋势，不覆盖已输入的内容
  refreshData() {
    if (this._dirtyInputs) this.refreshStats()
    else this.loadMonth()
    this.loadPeriods()
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.m })
  },

  // ================= 月度 =================
  shiftYM(ym, delta) {
    const [y, m] = ym.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    return util.monthKey(d.getFullYear(), d.getMonth() + 1)
  },

  loadMonth() {
    const ym = this.data.ym
    const [y, m] = ym.split('-').map(Number)
    const met = store.getMetrics(ym)
    const hasOverride = store.hasMonthOverride(ym)
    const def = store.getMonthlyDefault()
    this._dirtyInputs = false
    this.setData({
      monthTitle: y + '年' + util.pad(m) + '月',
      defaultBudget: def ? String(def) : '',
      hasOverride,
      monthOverride: hasOverride ? String(store.getBudget(ym)) : '',
      spent: util.money(met.budgetSpent), // 已占用预算（不含「不计入预算」的账单）
      left: util.money(met.budgetLeft),
      trend: budgetChart(store.budgetTrend(ym))
    })
  },

  // 只刷新「已支出 / 剩余预算 / 趋势图」，不动输入框
  refreshStats() {
    const ym = this.data.ym
    const met = store.getMetrics(ym)
    this.setData({
      spent: util.money(met.budgetSpent),
      left: util.money(met.budgetLeft),
      trend: budgetChart(store.budgetTrend(ym))
    })
  },

  prevMonth() { this.setData({ ym: this.shiftYM(this.data.ym, -1) }); this.loadMonth() },
  nextMonth() { this.setData({ ym: this.shiftYM(this.data.ym, 1) }); this.loadMonth() },

  onDefaultBudget(e) { this._dirtyInputs = true; this.setData({ defaultBudget: e.detail.value }) },
  onMonthOverride(e) { this._dirtyInputs = true; this.setData({ monthOverride: e.detail.value }) },

  // 预算 / 账户设置推到云端（防抖合并 + 串行 + 失败自动重试，见 store.touchMeta）。
  // 这里不等防抖、立即推一次，并如实告诉用户结果：已同步 / 暂未同步（会自动重试）/ 未登录（仅本机）
  syncNote(okText) {
    store.flushMeta().then(r => {
      const title = r === true ? okText + '，已同步云端'
        : r === false ? okText + '，云同步失败将自动重试'
        : okText
      wx.showToast({ title, icon: r === false ? 'none' : 'success' })
    })
  },

  onHide() { store.flushMeta(); this.unwatch() },
  onUnload() { store.flushMeta(); this.unwatch() },

  // 清除本月单独设置，恢复使用每月预算（默认值）
  clearOverride() {
    store.clearMonthOverride(this.data.ym)
    this.loadMonth()
    this.syncNote('已恢复为每月预算')
  },

  toggle(e) {
    const k = e.currentTarget.dataset.k
    this._dirtyInputs = true
    this.setData({ [k]: !this.data[k] })
  },

  saveMonth() {
    store.setMonthlyDefault(Number(this.data.defaultBudget) || 0)
    const v = this.data.monthOverride.trim()
    if (v === '') {
      if (this.data.hasOverride) store.clearMonthOverride(this.data.ym)
    } else {
      store.setMonthOverride(this.data.ym, Number(v) || 0)
    }
    store.setBudgetConf({
      carry: this.data.carry,
      overcut: this.data.overcut
    })
    this.loadMonth()
    this.syncNote('已保存')
  },

  // ================= 特定周期 =================
  loadPeriods() {
    const list = store.getBudgetPeriods().map(p => {
      const spent = store.periodExpense(p.start, p.end)
      const left = p.amount - spent
      const pct = p.amount > 0 ? Math.max(0, Math.min(100, Math.round(spent / p.amount * 100))) : 0
      return {
        id: p.id,
        name: p.name,
        range: p.start + ' ~ ' + p.end,
        amountText: util.money(p.amount),
        spentText: util.money(spent),
        leftText: util.money(left),
        pct,
        over: left < 0
      }
    }).sort((a, b) => (a.range < b.range ? 1 : -1))
    this.setData({ periods: list })
  },

  openPeriodSheet(e) {
    const id = e.currentTarget.dataset.id
    if (id) {
      const p = store.getBudgetPeriod(id)
      if (!p) return
      this.setData({
        periodSheet: true,
        periodEditId: id,
        periodName: p.name,
        periodStart: p.start,
        periodEnd: p.end,
        periodAmount: String(p.amount)
      })
    } else {
      const today = util.dateStr()
      this.setData({
        periodSheet: true,
        periodEditId: '',
        periodName: '',
        periodStart: today,
        periodEnd: today,
        periodAmount: ''
      })
    }
  },

  closePeriodSheet() { this.setData({ periodSheet: false }) },
  onPeriodName(e) { this.setData({ periodName: e.detail.value }) },
  onPeriodAmount(e) { this.setData({ periodAmount: e.detail.value }) },
  onPeriodStart(e) { this.setData({ periodStart: e.detail.value }) },
  onPeriodEnd(e) { this.setData({ periodEnd: e.detail.value }) },

  savePeriod() {
    const d = this.data
    if (d.periodStart > d.periodEnd) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' })
      return
    }
    const amount = Number(d.periodAmount) || 0
    if (!(amount > 0)) {
      wx.showToast({ title: '请输入预算金额', icon: 'none' })
      return
    }
    const payload = { name: d.periodName, start: d.periodStart, end: d.periodEnd, amount }
    if (d.periodEditId) {
      store.updateBudgetPeriod(d.periodEditId, payload)
    } else {
      store.addBudgetPeriod(payload)
    }
    this.setData({ periodSheet: false })
    this.loadPeriods()
    this.syncNote('已保存')
  },

  removePeriod(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除该周期预算？',
      confirmColor: '#F25350',
      success: (res) => {
        if (res.confirm) {
          store.removeBudgetPeriod(id)
          this.loadPeriods()
          this.syncNote('已删除')
        }
      }
    })
  }
})
