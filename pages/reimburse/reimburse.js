// pages/reimburse/reimburse.js 报销详情：汇总 + 每次到账记录（可撤销）+ 结束后可重新开启
const store = require('../../utils/store')
const util = require('../../utils/util')

Page({
  data: {
    statusBarHeight: 20,
    id: '',
    accountName: '',
    amountText: '',
    receivedText: '',
    pendingText: '',
    done: false,
    records: []
  },

  onLoad(o) {
    this.setData({ id: o.id, statusBarHeight: wx.getWindowInfo().statusBarHeight || 20 })
  },

  onShow() { this.load() },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  goBack() { wx.navigateBack() },

  load() {
    const b = store.getBill(this.data.id)
    const info = store.reimburseInfo(b)
    if (!info) { wx.navigateBack(); return }
    const amt = Number(b.amount) || 0
    const merchant = Math.round((store.refundTotal(b) - info.received) * 100) / 100
    const pending = info.done ? 0 : Math.max(Math.round((amt - merchant - info.received) * 100) / 100, 0)
    this.setData({
      accountName: info.accountName,
      amountText: util.money(amt),
      receivedText: util.money(info.received),
      pendingText: util.money(pending),
      done: info.done,
      records: info.records.slice().reverse().map(r => ({
        id: r.id,
        amount: '+' + util.money(r.amount),
        account: r.account || '未指定账户',
        date: r.date,
        remark: r.remark || ''
      }))
    })
  },

  undo(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '撤销这条报销到账？',
      content: '该笔金额会从到账账户扣回，账单恢复为待报销',
      confirmColor: '#F25350',
      success: (r) => {
        if (!r.confirm) return
        store.removeRefund(this.data.id, id)
        this.load()
      }
    })
  },

  reopen() {
    if (store.reopenReimbursement(this.data.id)) {
      wx.showToast({ title: '已重新开启报销', icon: 'success' })
      this.load()
    }
  }
})
