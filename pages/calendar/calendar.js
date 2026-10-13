// pages/calendar/calendar.js
const util = require('../../utils/util')
const store = require('../../utils/store')

// ---- 日结余热力色：结余为正 → 浅绿，为负 → 浅红；金额越大颜色越深 ----
// 对数刻度 + 缓起曲线：几十元只是几乎看不出的一抹淡色，上千元才明显加深，约 1 万元及以上最深，
// 单日大额不会把其它天“压没”。
// 收入绿字 / 支出红字在任何底色上都保持原色（不随底色切换），所以最深一档也必须是浅色调，
// alpha 范围 [0.05, 0.32]，保证红/绿数字始终可读。
const HEAT_CAP = Math.log10(10001)
const HEAT_MIN = 0.05
const HEAT_MAX = 0.32
const GREEN = '69,168,136' // #45A888
const RED = '242,83,80'    // #F25350

function heat(net) {
  if (!net) return ''
  const t = Math.pow(Math.min(1, Math.log10(1 + Math.abs(net)) / HEAT_CAP), 1.5)
  const a = HEAT_MIN + (HEAT_MAX - HEAT_MIN) * t
  return 'rgba(' + (net > 0 ? GREEN : RED) + ',' + a.toFixed(3) + ')'
}

Page({
  data: {
    weekHead: ['一', '二', '三', '四', '五', '六', '日'], // 周一为一周起点
    year: 0,
    month: 0,
    title: '',
    weeks: [],
    selectedDate: '',
    selectedWeek: '',
    selectedDateText: '',
    dayExpense: 0,
    dayIncome: 0,
    dayBalance: '0.00',
    groups: [],
    isCurrentMonth: true,
    monthExpense: '0.00',
    monthIncome: '0.00',
    monthBalance: '0.00'
  },

  onLoad() {
    const now = new Date()
    this.setData({ selectedDate: util.dateStr() })
    this.buildMonth(now.getFullYear(), now.getMonth() + 1)
  },

  onShow() {
    if (this.data.year) this.refresh()
  },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  refresh() {
    this.buildMonth(this.data.year, this.data.month)
  },

  onPageScroll(e) {
    this.selectComponent('#fab').onScroll(e.scrollTop)
  },

  buildMonth(year, month) {
    const ym = util.monthKey(year, month)
    const dayMap = store.monthDayMap(ym)
    const first = new Date(year, month - 1, 1)
    // 周一起始：getDay() 周日=0 → 6，周一=1 → 0 ...
    const startWd = (first.getDay() + 6) % 7
    const dim = util.daysInMonth(year, month)
    const today = util.dateStr()

    // 只画本月需要的周数（4~6 行）；上月末 / 下月初的补位格留空，不显示日期
    const rows = Math.ceil((startWd + dim) / 7)
    const cells = []
    for (let i = 0; i < rows * 7; i++) {
      const n = i - startWd + 1
      if (n < 1 || n > dim) { cells.push({ id: i, empty: true }); continue }

      const date = ym + '-' + util.pad(n)
      const d = dayMap[date]
      const hasExpense = d && d.expense > 0
      const hasIncome = d && d.income > 0
      const isSelected = date === this.data.selectedDate

      // 日结余 = 收入 - 支出（按分取整，避免浮点误差把 0 算成 ±0.00…01）
      const net = d ? Math.round(((d.income || 0) - (d.expense || 0)) * 100) / 100 : 0

      cells.push({
        id: i,
        day: n,
        date,
        isToday: date === today,
        isSelected,
        expense: hasExpense ? this.compact(d.expense) : '',
        income: hasIncome ? this.compact(d.income) : '',
        hasData: !!(hasExpense || hasIncome),
        // 选中格用纯色 #3CB371，不再叠热力底色
        bg: isSelected ? '' : heat(net)
      })
    }
    const weeks = []
    for (let i = 0; i < rows; i++) weeks.push(cells.slice(i * 7, i * 7 + 7))

    // 月度汇总
    let mExp = 0, mInc = 0
    Object.values(dayMap).forEach(d => {
      mExp += d.expense || 0
      mInc += d.income || 0
    })

    const now2 = new Date()
    this.setData({
      year, month,
      title: year + '年' + month + '月',
      weeks,
      isCurrentMonth: now2.getFullYear() === year && now2.getMonth() + 1 === month,
      monthExpense: util.money(mExp),
      monthIncome: util.money(mInc),
      monthBalance: util.money(mInc - mExp)
    })
    this.loadSelected()
  },

  // 紧凑金额：统一规则，整数显示整数，非整数最多1位小数
  compact(v) {
    if (v >= 10000) return (v / 10000).toFixed(1) + 'w'
    if (Number.isInteger(v)) return String(v)
    // 非整数：保留1位小数，去掉末尾0
    const s = v.toFixed(1)
    return s.endsWith('.0') ? s.slice(0, -2) : s
  },

  loadSelected() {
    const date = this.data.selectedDate
    if (!date) return
    const bills = store.getBillsSync().filter(b => b.date === date)
    let income = 0, expense = 0
    bills.forEach(b => {
      const ft = store.flowType(b)
      if (ft === 'income') income += store.billAmount(b)
      if (ft === 'expense') expense += store.billAmount(b)
    })

    // 格式化选中日期显示：10月5日
    const [, m, d] = date.split('-')
    const dateText = Number(m) + '月' + Number(d) + '日'

    this.setData({
      selectedWeek: util.weekday(date),
      selectedDateText: dateText,
      dayIncome: util.money(income),
      dayExpense: util.money(expense),
      dayBalance: util.money(income - expense),
      groups: store.groupBills(bills)
    })
  },

  tapCell(e) {
    const date = e.currentTarget.dataset.date
    if (!date) return
    this.setData({ selectedDate: date })
    this.buildMonth(this.data.year, this.data.month)
  },

  shift(e) {
    const delta = typeof e === 'number' ? e : (e.currentTarget.dataset.d)
    const d = new Date(this.data.year, this.data.month - 1 + Number(delta), 1)
    this.buildMonth(d.getFullYear(), d.getMonth() + 1)
  },

  goToday() {
    const now = new Date()
    this.setData({ selectedDate: util.dateStr() })
    this.buildMonth(now.getFullYear(), now.getMonth() + 1)
  },

  tapItem(e) {
    wx.navigateTo({ url: '/pages/bill-detail/bill-detail?id=' + e.currentTarget.dataset.id })
  }
})
