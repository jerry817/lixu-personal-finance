// pages/search/search.js
// ?mode=export（精准导出）：长按账单开始多选，已选的账单可跨多次搜索保留，点「导出」交给 packages/excel 的导出页
const store = require('../../utils/store')

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'expense', label: '支出' },
  { key: 'income', label: '收入' },
  { key: 'transfer', label: '转账' },
  { key: 'debt', label: '债务' }
]

Page({
  data: {
    statusBarHeight: 20,
    filters: FILTERS,
    type: '',
    kw: '',
    start: '',
    end: '',
    groups: [],
    exportMode: false, // 精准导出：长按选账单
    picked: {},        // 已选账单 id → true
    pickedCount: 0,
    allPicked: false,  // 当前搜索结果是否已全部选中
    viewMode: 'detail' // 与首页同一个「简洁 / 详细」设置：详细模式显示标签、备注和账户
  },

  onLoad(options) {
    const win = wx.getWindowInfo()
    this.setData({ statusBarHeight: win.statusBarHeight, exportMode: options.mode === 'export' })
    this.runSearch()
    this._loaded = true
  },

  // 从账单详情返回：账单可能被改了或删了，重新搜一遍（首次进入 onLoad 已搜过）
  onShow() {
    if (this._loaded) this.runSearch()
  },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  goBack() {
    wx.navigateBack()
  },

  clearKw() {
    this.setData({ kw: '' })
    this.runSearch()
  },

  onKw(e) {
    this.setData({ kw: e.detail.value })
    this.runSearch()
  },

  setType(e) {
    this.setData({ type: e.currentTarget.dataset.key })
    this.runSearch()
  },

  onStart(e) {
    let v = e.detail.value
    if (this.data.end && v > this.data.end) v = this.data.end
    this.setData({ start: v })
    this.runSearch()
  },

  onEnd(e) {
    let v = e.detail.value
    if (this.data.start && v < this.data.start) v = this.data.start
    this.setData({ end: v })
    this.runSearch()
  },

  clearDates() {
    this.setData({ start: '', end: '' })
    this.runSearch()
  },

  runSearch() {
    const { kw, type, start, end } = this.data
    const groups = store.search({ kw, type, start, end })
    this.setData({
      groups,
      viewMode: store.getViewMode()
    })
    this.setPicked(this.data.picked)
  },

  // ------------------------------------------------ 精准导出：多选
  // 更新已选集合，并重算已选笔数 / 当前结果是否全选
  setPicked(picked) {
    const ids = this.visibleIds()
    this.setData({
      picked,
      pickedCount: Object.keys(picked).length,
      allPicked: ids.length > 0 && ids.every(id => picked[id])
    })
  },

  visibleIds() {
    return this.data.groups.reduce((ids, g) => ids.concat(g.items.map(it => it.id)), [])
  },

  togglePick(id) {
    const picked = Object.assign({}, this.data.picked)
    if (picked[id]) delete picked[id]
    else picked[id] = true
    this.setPicked(picked)
  },

  onLongPress(e) {
    if (!this.data.exportMode) return
    wx.vibrateShort({ type: 'light' })
    this.togglePick(e.currentTarget.dataset.id)
  },

  // 全选 / 取消全选当前搜索结果（其它搜索里已选的不受影响）
  togglePickAll() {
    const picked = Object.assign({}, this.data.picked)
    const all = this.data.allPicked
    this.visibleIds().forEach(id => { if (all) delete picked[id]; else picked[id] = true })
    this.setPicked(picked)
  },

  clearPicked() { this.setPicked({}) },

  goExport() {
    getApp().globalData.exportIds = Object.keys(this.data.picked)
    wx.navigateTo({ url: '/packages/excel/pages/export/export?kind=picked' })
  },

  // 点击账单：选择中 = 切换选中；否则和首页一样进入账单详情（在详情页查看 / 编辑 / 删除）
  tapItem(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.pickedCount) this.togglePick(id)
    else wx.navigateTo({ url: '/pages/bill-detail/bill-detail?id=' + id })
  }
})
