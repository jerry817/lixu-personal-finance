// pages/index/index.js
const store = require('../../utils/store')
const util = require('../../utils/util')

const METRIC_LABEL = {}
store.METRICS.forEach(m => { METRIC_LABEL[m.key] = m.label })

const PAGE_GROUPS = 8 // 首页账单懒加载：每次渲染 8 个日分组

// 下拉添加账单：横幅在页面内把内容向下推；横幅高度达到 ADD_TRIGGER（px）松手 → 进入「添加新记账」
const ADD_TRIGGER = 68
const READY_HYST = 8   // 已达阈值后，高度回落超过该值才取消「松开添加」，避免手指在阈值附近抖动时文案 / 颜色来回闪
const PULL_MAX = 190
const PULL_GATE = 10   // 起手识别：纵向位移超过该值才接管；横幅高度从 0 起连续增长（不再从 5px 跳出）
const PULL_ANIM_MS = 260 // 松手回弹时长，需与 index.wxss 里 .pbd-anim / .pb-anim 的 transition 一致

function slotOf(key, m) {
  const v = m[key]
  return { key, label: METRIC_LABEL[key], value: key === 'count' ? v + '笔' : util.money(v) }
}

Page({
  data: {
    statusBarHeight: 20,
    navH: 44,         // 导航栏内容高度，与其他页面一致：(胶囊顶 − 状态栏) × 2 + 胶囊高
    navBottom: 64,    // 导航栏底边 = 状态栏 + navH
    rightInset: 100,
    popTop: 90,
    popRight: 8,
    moreVisible: false,
    viewMode: 'detail',
    timeRange: 'all', // all=全部账单（默认）；month=只看 ym 这个月
    ym: '',             // 按月时展示的月份（YYYY-MM）
    monthLabel: '',
    refreshing: false,
    pullDist: 0,      // 下拉横幅高度（px）
    pullReady: false, // 是否达到添加账单阈值
    pulling: false,   // 正在拖动（拖动时无过渡才跟手；松手后加过渡回弹）
    pullActive: false, // 下拉进行中 + 松手回弹期间：横幅可见、内容层提升为合成层（回弹结束后撤销，避免长期占用显存）
    slots: { row: [], big: {} },
    budget: {},
    groups: [],
    shownGroups: 0,
    hasMore: false,
    manageMode: false,
    selected: {},
    allSelected: false
  },

  onLoad() {
    this.measure()
    const now = new Date()
    this.setData({ ym: util.monthKey(now.getFullYear(), now.getMonth() + 1) })
  },

  onUnload() {
    clearTimeout(this._pullTimer)
    clearTimeout(this._justShownTimer)
  },

  onShow() {
    this._justShown = true
    clearTimeout(this._justShownTimer)
    this._justShownTimer = setTimeout(() => { this._justShown = false }, 200)
    this.refreshIfChanged()
    store.retryMetaIfDirty() // 上次没同步成功的账户 / 预算改动，回到首页时补推
  },

  measure() {
    const win = wx.getWindowInfo()
    const sb = win.statusBarHeight || 20
    let navH = 44
    let rightInset = 100
    let popTop = 90
    let popRight = 8
    try {
      const mb = wx.getMenuButtonBoundingClientRect()
      if (mb && mb.height) {
        // 与原生导航栏 / 其他自定义顶栏页同一公式：胶囊上下各留同样的空隙，
        // 首页之前只用「状态栏 + 胶囊高」，比其他页矮一截，且右侧图标与胶囊不在同一水平线
        navH = (mb.top - sb) * 2 + mb.height
        rightInset = win.screenWidth - mb.left + 10
        popTop = mb.bottom + 8
        popRight = win.screenWidth - mb.right
      }
    } catch (e) { /* 取不到胶囊就用默认值 */ }
    this.setData({
      statusBarHeight: sb,
      navH,
      navBottom: sb + navH,
      rightInset,
      popTop,
      popRight
    })
  },

  // 渲染依据：本地数据版本 + 当前月份 + 今天的日期（跨天后「今日」类指标会变）
  renderKey() {
    return [store.revision(), this.data.ym, util.dateStr()].join('|')
  },

  // 回到首页（onShow、后台同步完成）时：数据 / 月份 / 日期都没变就跳过，省掉每次约 100ms 的指标计算、分组和 setData
  refreshIfChanged(keepPaging) {
    if (this.renderKey() !== this._renderKey) this.refresh(keepPaging)
  },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）。
  // 保持当前已展开的日分组数量：用户已经往下翻了很多页时，不能因为后台同步把列表缩回第一页
  onDataChanged() {
    this.refreshIfChanged(true)
  },

  refresh(keepPaging) {
    this._renderKey = this.renderKey()
    const now = new Date()
    const m = store.getCardMetrics()
    const cfg = store.getCardConfig()

    // 进度条呈递减趋势：显示剩余预算占比（支出越多，进度条越短）
    const progress = m.budgetTotal > 0
      ? Math.min(100, m.budgetLeft / m.budgetTotal * 100)
      : 0

    // 账单列表：按时间范围（全部 / 某个月）展示，按日分组倒序，首批只渲染 PAGE_GROUPS 组，触底再追加
    const timeRange = store.getTimeRange()
    const ym = this.data.ym
    this.allGroups = store.groupBills(timeRange === 'month' ? store.monthBills(ym) : store.getBillsSync())
    const n = Math.min(keepPaging ? Math.max(PAGE_GROUPS, this.data.shownGroups) : PAGE_GROUPS, this.allGroups.length)
    this.setData({
      viewMode: store.getViewMode(),
      timeRange,
      monthLabel: ym.slice(0, 4) + '年' + Number(ym.slice(5)) + '月',
      slots: {
        row: [slotOf(cfg.s1, m), slotOf(cfg.s2, m), slotOf(cfg.s3, m)],
        big: {
          label: METRIC_LABEL[cfg.sb],
          unit: cfg.sb === 'expense' ? ' (元)' : '',
          value: slotOf(cfg.sb, m).value
        }
      },
      budget: {
        title: (now.getMonth() + 1) + '月预算',
        left: util.money(m.budgetLeft),
        total: util.money(m.budgetTotal),
        used: util.money(m.budgetSpent),
        dailyBudget: util.money(m.dailyBudget),
        dailyAvg: util.money(m.dailyAvg),
        todayLeft: util.money(m.todayLeft),
        percent: progress
      },
      groups: this.allGroups.slice(0, n),
      shownGroups: n,
      hasMore: this.allGroups.length > n
    })
    // 管理模式下刷新（如编辑后返回）：恢复勾选视觉
    if (this.data.manageMode) this.applySelection(this.data.selected)
  },

  // 触底懒加载：再渲染 PAGE_GROUPS 个日分组
  onReachBottom() {
    if (!this.data.hasMore) return
    const next = Math.min(this.data.shownGroups + PAGE_GROUPS, this.allGroups.length)
    this.setData({
      groups: this.allGroups.slice(0, next),
      shownGroups: next,
      hasMore: next < this.allGroups.length
    })
  },

  // ------------------------------------------------ 页面滚动
  onPageScroll(e) {
    const top = e.scrollTop
    this._scrollTop = top
    const fab = this.selectComponent('#fab') // 批量管理模式下悬浮钮不存在
    if (fab) fab.onScroll(top)
  },

  // ------------------------------------------------ 下拉添加账单（页面内横幅）
  // 横幅（.pull-banner）与内容层（.pull-body）都只由 pullDist 驱动：
  //   · 内容层用 transform 下移（不触发整页重排，拖动时只做合成）；
  //   · 横幅向上延伸到导航栏下面，iOS 顶部回弹带着整页下移时，横幅顶边仍藏在导航栏后面、底边与内容层同步，
  //     不再需要在 onPageScroll 里异步补偿回弹量（那一步比原生回弹晚一两帧，是横幅与导航栏之间闪缝的来源）。
  onTouchStart(e) {
    this._startY = e.touches[0].clientY
    this._startX = e.touches[0].clientX
    this._startScroll = this._scrollTop || 0
    this._pulling = false
  },

  onTouchMove(e) {
    // 起手时页面不在顶部：交给正常滚动
    if (this._startScroll > 0) return
    const dy = e.touches[0].clientY - this._startY
    const dx = e.touches[0].clientX - this._startX
    let extra = null
    if (!this._pulling) {
      // 纵向意图确认（仅起手时）：超过阈值且垂直位移占主导，避免横滑日期 / 账户 chips 时误触发
      if (dy < PULL_GATE || Math.abs(dy) < Math.abs(dx)) return
      this._pulling = true
      clearTimeout(this._pullTimer)
      extra = { pulling: true, pullActive: true }
    }
    // 一旦接管就一直跟手到松手：手指回到起点以上时高度为 0，但不退出下拉状态，
    // 来回拖动不会反复开关过渡、也没有重新起手的死区
    this.updatePull(Math.min(Math.max(dy - PULL_GATE, 0) * 0.5, PULL_MAX), extra)
  },

  // 只在高度（取整像素）或「松开添加」状态真正变化时 setData；已达阈值的状态带滞回
  updatePull(dist, extra) {
    dist = Math.round(dist)
    const was = this.data.pullReady
    const ready = was ? dist >= ADD_TRIGGER - READY_HYST : dist >= ADD_TRIGGER
    const patch = extra || {}
    if (dist !== this.data.pullDist) patch.pullDist = dist
    if (ready !== was) patch.pullReady = ready
    if (Object.keys(patch).length) this.setData(patch)
  },

  onTouchEnd() {
    if (!this._pulling) return
    const ready = this.data.pullReady
    this.releasePull()
    if (ready) this.goAdd()
  },

  // 系统打断（来电 / 手势等）：只收起，不触发添加
  onTouchCancel() {
    if (this._pulling) this.releasePull()
  },

  // 收起横幅（带回弹过渡）；回弹结束后再撤掉 pullActive（隐藏横幅、撤销合成层）
  releasePull() {
    this._pulling = false
    this.setData({ pullDist: 0, pullReady: false, pulling: false })
    clearTimeout(this._pullTimer)
    this._pullTimer = setTimeout(() => this.setData({ pullActive: false }), PULL_ANIM_MS + 60)
  },

  // 点击底部 tabBar「首页」图标：仅当已处于首页时，快速回到顶部并触发刷新；
  // 从其他页面点击首页 tab 时仅切换到首页（onShow 会正常刷新数据），不重复触发。
  // 用 setTimeout 确保判断发生在 onShow 同步执行之后，_justShown 标志已就绪。
  onTabItemTap(e) {
    if (e && e.index !== 0) return
    setTimeout(() => {
      if (this._justShown) return
      wx.pageScrollTo({ scrollTop: 0, duration: 300 })
      this.startRefresh()
    }, 0)
  },

  // 刷新：已登录云 → 先完整云同步（拉取其它设备改动 + 推送本机新增/退款/删除），完成后再渲染，
  //   避免「动画收了但数据还没回来」；未登录 → 仅刷新本地数据。
  startRefresh() {
    if (this.data.refreshing) return
    this.setData({ refreshing: true })
    const finish = () => {
      this.refresh()
      setTimeout(() => this.setData({ refreshing: false }), 400)
    }
    if (store.cloudLoggedIn()) {
      // 15 秒超时兜底，弱网下避免动画一直转
      Promise.race([
        store.syncAll(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('sync-timeout')), 15000))
      ]).then(finish).catch(() => {
        this.refresh()
        this.setData({ refreshing: false })
      })
    } else {
      this.refresh()
      setTimeout(() => this.setData({ refreshing: false }), 600)
    }
  },

  // ------------------------------------------------ 导航
  openSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  toggleMore() {
    this.setData({ moreVisible: !this.data.moreVisible })
  },

  closeMore() {
    this.setData({ moreVisible: false })
  },

  openCardSetting() {
    wx.navigateTo({ url: '/pages/card-setting/card-setting' })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/add/add' })
  },

  // ------------------------------------------------ 更多菜单动作
  moreCard() {
    this.closeMore()
    this.openCardSetting()
  },

  moreAIImport() {
    this.closeMore()
    wx.chooseMedia({
      count: 1, mediaType: ['image'],
      success: () => {
        wx.showToast({ title: '截图识别接口预留', icon: 'none' })
      }
    })
  },

  moreTemplate() {
    this.closeMore()
    wx.navigateTo({ url: '/pages/templates/templates' })
  },

  moreBudget() {
    this.closeMore()
    this.goBudget()
  },

  // 预算卡片：点击进入预算管理
  goBudget() {
    wx.navigateTo({ url: '/pages/budget/budget' })
  },

  setView(e) {
    const mode = e.currentTarget.dataset.mode
    store.setViewMode(mode)
    this.setData({ viewMode: mode })
  },

  setRange(e) {
    store.setTimeRange(e.currentTarget.dataset.range)
    this.refresh()
  },

  pickMonth(e) {
    this.setData({ ym: e.detail.value }, () => this.refresh())
  },

  importShot(e) {
    this.closeMore()
    const src = e.currentTarget.dataset.src
    wx.chooseMedia({
      count: 9, mediaType: ['image'],
      success: () => {
        wx.showToast({ title: src + '截图导入预留', icon: 'none' })
      }
    })
  },

  // ------------------------------------------------ 账单操作
  tapItem(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/bill-detail/bill-detail?id=' + id })
  },

  // 点击账单：管理模式下切换勾选，否则进入详情
  tapBill(e) {
    if (this.data.manageMode) {
      this.toggleSelect(e.currentTarget.dataset.id)
      return
    }
    this.tapItem(e)
  },

  // 长按账单 → 进入批量管理模式，并选中当前账单
  longPressBill(e) {
    if (!this.data.manageMode) this.setData({ manageMode: true })
    this.toggleSelect(e.currentTarget.dataset.id)
  },

  toggleSelect(id) {
    const sel = Object.assign({}, this.data.selected)
    if (sel[id]) delete sel[id]
    else sel[id] = true
    this.applySelection(sel)
  },

  // 勾选状态同步到列表视图（item.sel）与计数
  applySelection(sel) {
    this.allGroups.forEach(g => g.items.forEach(it => { it.sel = !!sel[it.id] }))
    const total = this.allGroups.reduce((s, g) => s + g.items.length, 0)
    const count = Object.keys(sel).length
    this.setData({
      selected: sel,
      allSelected: total > 0 && count === total,
      groups: this.allGroups.slice(0, this.data.shownGroups)
    })
  },

  toggleAll() {
    let sel = {}
    if (!this.data.allSelected) {
      this.allGroups.forEach(g => g.items.forEach(it => { sel[it.id] = true }))
    }
    this.applySelection(sel)
  },

  exitManage() {
    this.allGroups.forEach(g => g.items.forEach(it => { delete it.sel }))
    this.setData({
      manageMode: false,
      selected: {},
      allSelected: false,
      groups: this.allGroups.slice(0, this.data.shownGroups)
    })
  },

  // ---------------- 批量管理底部动作
  manageEdit() {
    const ids = Object.keys(this.data.selected)
    if (ids.length !== 1) {
      wx.showToast({ title: '请选择一笔账单编辑', icon: 'none' })
      return
    }
    wx.redirectTo({ url: '/pages/add/add?edit=' + ids[0] })
  },

  manageDelete() {
    const ids = Object.keys(this.data.selected)
    if (!ids.length) { wx.showToast({ title: '请先选择账单', icon: 'none' }); return }
    wx.showModal({
      title: '删除选中账单',
      content: '共 ' + ids.length + ' 笔，删除后不可恢复',
      confirmColor: '#F25350',
      success: res => {
        if (!res.confirm) return
        ids.forEach(id => store.removeBill(id))
        this.exitManage()
        this.refresh()
      }
    })
  },

  manageStats() {
    const sel = this.data.selected
    let inc = 0, exp = 0, n = 0
    this.allGroups.forEach(g => g.items.forEach(it => {
      if (!sel[it.id]) return
      n++
      const b = it.raw
      const ft = store.flowType(b)
      if (ft === 'income') inc += store.statIncome(b)
      else if (ft === 'expense') exp += store.statExpense(b)
    }))
    if (!n) { wx.showToast({ title: '请先选择账单', icon: 'none' }); return }
    wx.showModal({
      title: '选中账单统计',
      content:
        '笔数：' + n + '\n' +
        '收入：' + util.money(inc) + '\n' +
        '支出：' + util.money(exp) + '\n' +
        '结余：' + util.money(inc - exp),
      showCancel: false
    })
  },

  manageCombine() {
    wx.showToast({ title: '组合功能预留', icon: 'none' })
  },

  manageExport() {
    wx.showToast({ title: '导出功能预留', icon: 'none' })
  }
})
