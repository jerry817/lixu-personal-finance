// pages/category/category.js
const store = require('../../utils/store')
const cats = require('../../utils/categories')

Page({
  data: {
    expense: [],
    income: [],
    hiddenCount: 0
  },

  onShow() { this.refresh() },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  refresh() {
    const counts = {}
    store.getBillsSync().forEach(b => {
      counts[b.catId] = (counts[b.catId] || 0) + 1
    })
    const map = (type) => {
      const hidden = store.getHiddenCats(type)
      return store.allCats(type).map(c => ({
        id: c.id,
        label: c.label,
        icon: cats.iconPath(c.icon, false),
        count: counts[c.id] || 0,
        isHidden: hidden.indexOf(c.id) >= 0
      }))
    }
    const expense = map('expense')
    const income = map('income')
    this.setData({
      expense,
      income,
      hiddenCount: expense.concat(income).filter(c => c.isHidden).length
    })
  },

  toggle(e) {
    const { id, type } = e.currentTarget.dataset
    const visible = e.detail.value
    store.setCatHidden(type, id, !visible)
    this.refresh()
  },

  reset() {
    store.clearHiddenCats()
    this.refresh()
    wx.showToast({ title: '已全部显示', icon: 'success' })
  }
})
