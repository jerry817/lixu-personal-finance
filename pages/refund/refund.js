// pages/refund/refund.js
const util = require('../../utils/util')
const store = require('../../utils/store')
const kinds = require('../../utils/accountKinds')

// 日期展示为「2026年10月03日」
function dateCN(d) {
  const p = d.split('-')
  return p[0] + '年' + Number(p[1]) + '月' + p[2] + '日'
}

Page({
  data: {
    statusBarHeight: 20,
    billId: '',
    origAmount: 0,
    refunded: 0,
    remain: 0,
    amount: '',
    remark: '',
    accountId: '',
    accountName: '',
    date: '',
    dateLabel: '',
    accSheet: false,
    accList: [],
    refundList: [],   // 已记录的退款（最新在前）
    editingId: '',    // 正在修改的退款记录 id；空 = 追加新退款
    saveText: '确认退款'
  },

  onLoad(o) {
    this.setData({ statusBarHeight: wx.getWindowInfo().statusBarHeight })
    const b = store.getBill(o.id)
    if (!b || b.type !== 'expense') {
      wx.showToast({ title: '该账单不支持退款', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 500)
      return
    }
    this.setData({ billId: b.id, origAmount: b.amount })
    wx.setNavigationBarTitle({ title: '退款' })
    this.reload()
    this.resetForm()
  },

  // 重新读取账单：已退/可退金额 + 退款记录列表
  reload() {
    const b = store.getBill(this.data.billId)
    const refunded = store.refundTotal(b)
    const remain = Math.round(((b.amount || 0) - refunded) * 100) / 100
    const refundList = (b.refunds || []).slice().reverse().map(r => ({
      id: r.id,
      amountText: util.money(r.amount),
      account: r.account,
      date: r.date,
      dateLabel: dateCN(r.date),
      remark: r.remark || '',
      isReimb: r.kind === 'reimburse' // 报销到账（和退款一样冲减支出，在这里一并列出）
    }))
    this.setData({ refunded, remain, refundList })
  },

  // 表单重置为「追加新退款」
  resetForm() {
    const b = store.getBill(this.data.billId)
    this.setData({
      editingId: '',
      saveText: '确认退款',
      amount: this.data.remain > 0 ? String(this.data.remain) : '',
      remark: '',
      accountId: b.accountId,
      accountName: b.account
    })
    this.setDate(util.dateStr())
  },

  cancelEdit() { this.resetForm() },

  setDate(date) {
    this.setData({ date, dateLabel: dateCN(date) })
  },

  goBack() { wx.navigateBack() },

  onAmount(e) { this.setData({ amount: e.detail.value }) },
  onRemark(e) { this.setData({ remark: e.detail.value }) },
  onDateChange(e) { this.setDate(e.detail.value) },

  // 点击某条退款记录 → 载入表单进行修改
  editRefund(e) {
    const rid = e.currentTarget.dataset.id
    const b = store.getBill(this.data.billId)
    const r = b.refunds.find(x => x.id === rid)
    if (!r) return
    this.setData({
      editingId: rid,
      saveText: '保存修改',
      amount: String(r.amount),
      remark: r.remark || '',
      accountId: r.accountId,
      accountName: r.account
    })
    this.setDate(r.date)
  },

  // 删除（撤销）某条退款记录
  deleteRefund(e) {
    const rid = e.currentTarget.dataset.id
    wx.showModal({
      title: '撤销该笔退款？',
      content: '撤销后账单支出金额将恢复',
      confirmColor: '#F25350',
      success: res => {
        if (!res.confirm) return
        store.removeRefund(this.data.billId, rid)
        const wasEditing = this.data.editingId === rid
        this.reload()
        if (wasEditing) this.resetForm()
      }
    })
  },

  // 退款账户选择（债务账户不作为退款收款账户）
  openAccSheet() {
    const bills = store.getBillsSync()
    const list = store.getAccounts(false)
      .filter(a => kinds.groupOf(a) !== 'debt')
      .map(a => ({
        id: a.id, name: a.name, icon: a.icon,
        balanceText: util.money(store.availableBalance(a.id, bills)),
        selected: a.id === this.data.accountId
      }))
    this.setData({ accSheet: true, accList: list })
  },
  closeAccSheet() { this.setData({ accSheet: false }) },
  pickAccount(e) {
    const id = e.currentTarget.dataset.id
    const a = store.getAccount(id)
    this.setData({ accSheet: false, accountId: id, accountName: a ? a.name : '' })
  },

  // 保存：编辑已有记录 或 追加新退款（均直接减少原单支出，不新增账单）
  onSave() {
    const d = this.data
    const amt = Number(d.amount)
    if (!amt || amt <= 0) { wx.showToast({ title: '请输入退款金额', icon: 'none' }); return }

    if (d.editingId) {
      const err = store.updateRefund(d.billId, d.editingId, {
        amount: amt,
        accountId: d.accountId, account: d.accountName,
        date: d.date, remark: d.remark
      })
      if (err) { wx.showToast({ title: err, icon: 'none' }); return }
      wx.showToast({ title: '已修改', icon: 'success' })
      this.reload()
      this.resetForm()
      return
    }

    const b = store.getBill(d.billId)
    if (amt > store.effectiveExpense(b) + 0.001) {
      wx.showToast({ title: '退款不能超过可退' + store.effectiveExpense(b), icon: 'none' })
      return
    }
    const refunds = (b.refunds || []).concat([{
      id: util.genId(),
      amount: Math.round(amt * 100) / 100,
      accountId: d.accountId, account: d.accountName,
      date: d.date, remark: d.remark.trim(),
      createTime: Date.now()
    }])
    store.updateBill(d.billId, { refunds })
    wx.showToast({ title: '已退款', icon: 'success' })
    this.reload()
    this.resetForm()
  }
})
