// pages/tags/tags.js
const util = require('../../utils/util')
const store = require('../../utils/store')

Page({
  data: { list: [] },

  onShow() { this.refresh() },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  refresh() {
    this.setData({
      list: store.tagStats().map(x => ({
        tag: x.tag,
        count: x.count,
        expense: util.money(x.expense),
        income: util.money(x.income)
      }))
    })
  },

  tapTag(e) {
    const tag = e.currentTarget.dataset.tag
    wx.showActionSheet({
      itemList: ['重命名标签', '删除标签'],
      success: (res) => {
        if (res.tapIndex === 0) this.rename(tag)
        else this.del(tag)
      }
    })
  },

  rename(tag) {
    wx.showModal({
      title: '重命名标签',
      editable: true,
      content: tag,
      success: (res) => {
        if (res.confirm && res.content && res.content !== tag) {
          store.renameTag(tag, res.content.trim())
          this.refresh()
        }
      }
    })
  },

  del(tag) {
    wx.showModal({
      title: '删除标签“' + tag + '”？',
      content: '对应账单的标签将被清除，账单不会删除',
      confirmColor: '#F25350',
      success: (res) => {
        if (res.confirm) {
          store.deleteTag(tag)
          this.refresh()
        }
      }
    })
  }
})
