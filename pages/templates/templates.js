// pages/templates/templates.js
const util = require('../../utils/util')
const store = require('../../utils/store')

const TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账', debt: '债务' }

Page({
  data: { list: [] },

  onShow() { this.refresh() },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  refresh() {
    this.setData({
      list: store.getTemplates().map(t => {
        const c = store.getCat(t.catId, t.type)
        return {
          id: t.id,
          name: t.name,
          typeLabel: TYPE_LABEL[t.type] || '支出',
          catLabel: t.type === 'transfer' ? '账户转账' : (c ? c.label : ''),
          amount: util.money(t.amount),
          account: t.type === 'transfer'
            ? (t.account + '→' + t.toAccount) : t.account
        }
      })
    })
  },

  useTpl(e) {
    const id = e.currentTarget.dataset.id
    const t = store.getTemplates().find(x => x.id === id)
    if (!t) return
    const q = util.toQuery({
      tpl: 1,
      type: t.type,
      catId: t.catId,
      sub: t.sub || '',
      amount: t.amount,
      remark: t.remark || '',
      tag: t.tag || '',
      accountId: t.accountId || '',
      toAccountId: t.toAccountId || '',
      reimburse: t.reimburse ? '1' : '0'
    })
    wx.navigateTo({ url: '/pages/add/add?' + q })
  },

  delTpl(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除该模板？',
      confirmColor: '#F25350',
      success: (res) => {
        if (res.confirm) {
          store.removeTemplate(id)
          this.refresh()
        }
      }
    })
  }
})
