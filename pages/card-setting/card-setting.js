// pages/card-setting/card-setting.js
const store = require('../../utils/store')
const util = require('../../utils/util')

const ROWS = [
  { key: 's1', label: '首行第一个' },
  { key: 's2', label: '首行第二个' },
  { key: 's3', label: '首行第三个' },
  { key: 'sb', label: '次行第一个' }
]

const LABEL = {}
store.METRICS.forEach(m => { LABEL[m.key] = m.label })
const METRICS = store.METRICS

Page({
  data: {
    statusBarHeight: 20,
    cardTop: 150,
    rowView: [],
    slots: { row: [], big: {} },
    pickShow: false,
    pickSlot: '',
    pickTitle: '',
    groups: []
  },

  onLoad() {
    const win = wx.getWindowInfo()
    // 固定头部高度 = 状态栏 + 88rpx 头部行（rpx 换算 px），另留 12px 间距
    const headerRowPx = 88 * win.screenWidth / 750
    this.setData({
      statusBarHeight: win.statusBarHeight,
      cardTop: win.statusBarHeight + headerRowPx + 12
    })
    this.refresh()
  },

  refresh() {
    const m = store.getCardMetrics()
    const cfg = store.getCardConfig()
    const val = k => (k === 'count' ? m[k] + '笔' : util.money(m[k]))

    this.setData({
      rowView: ROWS.map(r => ({
        key: r.key,
        label: r.label,
        current: LABEL[cfg[r.key]]
      })),
      slots: {
        row: [
          { label: LABEL[cfg.s1], value: val(cfg.s1) },
          { label: LABEL[cfg.s2], value: val(cfg.s2) },
          { label: LABEL[cfg.s3], value: val(cfg.s3) }
        ],
        big: {
          label: LABEL[cfg.sb],
          unit: cfg.sb === 'expense' ? ' (元)' : '',
          value: val(cfg.sb)
        }
      }
    })
  },

  goBack() {
    wx.navigateBack()
  },

  // 点击某个数据位 → 打开分组指标选择弹层（指标数量多，ActionSheet 6 项上限不够用）
  tapRow(e) {
    const key = e.currentTarget.dataset.key
    const cfg = store.getCardConfig()
    const current = cfg[key]
    const gmap = {}
    METRICS.forEach(mm => {
      if (!gmap[mm.group]) gmap[mm.group] = { group: mm.group, items: [] }
      gmap[mm.group].items.push({ key: mm.key, label: mm.label, selected: mm.key === current })
    })
    const rowDef = ROWS.find(r => r.key === key)
    this.setData({
      pickShow: true,
      pickSlot: key,
      pickTitle: rowDef.label,
      groups: Object.values(gmap)
    })
  },

  closePick() {
    this.setData({ pickShow: false })
  },

  tapMetric(e) {
    const metricKey = e.currentTarget.dataset.key
    const cfg = store.getCardConfig()
    cfg[this.data.pickSlot] = metricKey
    store.setCardConfig(cfg)
    this.setData({ pickShow: false })
    this.refresh()
    wx.showToast({ title: '已更新', icon: 'success' })
  }
})
