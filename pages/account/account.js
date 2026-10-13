// pages/account/account.js
const util = require('../../utils/util')
const store = require('../../utils/store')
const kinds = require('../../utils/accountKinds')

// 账户类型分组
const TYPE_LABELS = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行卡',
  invest: '理财',
  other: '其他'
}

// 金额文本：透支 / 负数带负号
function signedMoney(v) {
  return (v < 0 ? '-' : '') + util.money(Math.abs(v))
}

Page({
  data: {
    net: '0.00',
    assets: '0.00',
    liability: '0.00',
    receivable: '0.00',
    payable: '0.00',
    reimburse: '0.00',
    // 定期存款卡片：在存本金 / 预计收益（只统计未到期的）；没有在存的定存时显示 --
    depositCount: 0,
    depositPrincipal: '0.00',
    depositIncome: '0.00',
    // 分组后的账户列表
    assetGroups: [],
    creditGroups: [],
    creditTotal: '0.00',
    assetTotal: '0.00',
    assetOpen: true,
    creditOpen: true,
    // 排序
    sortMode: 'default', // default | balance_desc | balance_asc | name
    // 隐藏账户
    hiddenCount: 0,
    showHiddenPanel: false,
    hiddenAccounts: [],
    // 金额隐藏
    hideMoney: false,
    // 账户总数
    totalCount: 0
  },

  onShow() {
    this.refresh()
  },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  refresh() {
    store.postDepositIncome() // 到期的定存先记上收益账单，下面的汇总才是最新的
    const s = store.getAssetSummary()
    const dp = store.depositSummary()
    const all = store.getAccounts(true)
    const views = store.getAccountViews()

    // 分离资产账户和信贷账户；债务分组账户不进资产/信贷列表
    const isDebtId = id => {
      const a = store.getAccount(id)
      return !!a && kinds.groupOf(a) === 'debt'
    }
    const assetAccounts = views.filter(v => !store.isCreditAccount(v) && !isDebtId(v.id))
    const creditAccounts = views.filter(v => store.isCreditAccount(v))

    // 资产账户卡片显示可用余额（账本余额 − 在存定存本金），排序也按可用余额
    assetAccounts.forEach(v => { v.balance = v.available })
    const sortedAssets = this._sort(assetAccounts)
    const sortedCredits = this._sort(creditAccounts)

    this.setData({
      net: util.money(s.net),
      assets: util.money(s.assets),
      liability: util.money(s.liability),
      receivable: util.money(s.receivable),
      payable: util.money(s.payable),
      reimburse: util.money(s.reimburse),
      depositCount: dp.count,
      depositPrincipal: util.money(dp.principal),
      depositIncome: util.money(dp.income),
      assetGroups: sortedAssets.map(v => this._toView(v)),
      assetTotal: signedMoney(assetAccounts.reduce((sum, v) => sum + v.balance, 0)),
      creditGroups: sortedCredits.map(v => this._toCreditView(v)),
      creditTotal: util.money(creditAccounts.reduce((sum, v) => sum + Math.max(0, -v.balance), 0)),
      hiddenCount: all.filter(a => a.hidden).length,
      hiddenAccounts: all.filter(a => a.hidden).map(a => ({
        id: a.id, name: a.name, icon: a.icon, type: a.type
      })),
      totalCount: views.length
    })
  },

  // 排序
  _sort(list) {
    let result = list
    const mode = this.data.sortMode
    if (mode === 'balance_desc') {
      result = result.slice().sort((a, b) => b.balance - a.balance)
    } else if (mode === 'balance_asc') {
      result = result.slice().sort((a, b) => a.balance - b.balance)
    } else if (mode === 'name') {
      result = result.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    }
    return result
  },

  // 资产账户的视图模型：透支时带负号并标红
  _toView(v) {
    const bal = v.balance
    return {
      id: v.id,
      name: v.name,
      icon: v.icon,
      type: v.type,
      typeLabel: TYPE_LABELS[v.type] || '',
      balanceText: signedMoney(bal),
      amtClass: bal < 0 ? 'amt-red' : 'amt-dark',
      depositText: v.held > 0 ? util.money(v.held) : '' // 在存定存合计：卡片上灰色小字
    }
  },

  // 信贷账户的视图模型：欠款（溢缴时显示负数）、额度使用进度条、剩余额度
  _toCreditView(v) {
    const c = store.creditInfo(v.id)
    return {
      id: v.id,
      name: v.name,
      icon: v.icon,
      owedText: (c.surplus > 0 ? '-' : '') + util.money(c.surplus > 0 ? c.surplus : c.owed),
      amtClass: c.owed > 0 ? 'amt-red' : 'amt-dark',
      pct: c.pct,
      limitText: c.limit > 0 ? '剩余额度 ' + util.money(c.remaining) : '额度未设置'
    }
  },

  toggleEye() {
    this.setData({ hideMoney: !this.data.hideMoney })
  },

  changeSort(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.sortMode) return
    this.setData({ sortMode: mode }, () => this.refresh())
  },

  // 折叠 / 展开分组卡：data-k = asset | credit
  toggleGroup(e) {
    const key = e.currentTarget.dataset.k + 'Open'
    this.setData({ [key]: !this.data[key] })
  },

  onPageScroll(e) {
    this.selectComponent('#fab').onScroll(e.scrollTop)
  },

  tapAccount(e) {
    wx.navigateTo({
      url: '/pages/account-detail/account-detail?id=' + e.currentTarget.dataset.id
    })
  },

  addAccount() {
    wx.navigateTo({ url: '/pages/account-add/account-add' })
  },

  // 显示/隐藏 隐藏账户面板
  toggleHiddenPanel() {
    if (!this.data.hiddenCount) {
      wx.showToast({ title: '暂无隐藏账户', icon: 'none' })
      return
    }
    this.setData({ showHiddenPanel: !this.data.showHiddenPanel })
  },

  // 恢复显示某个隐藏账户
  restoreAccount(e) {
    const id = e.currentTarget.dataset.id
    const acc = store.getAccount(id)
    if (!acc) return
    store.saveAccount(Object.assign({}, acc, { hidden: false }))
    wx.showToast({ title: '已恢复显示', icon: 'success' })
    this.refresh()
  },

  // 债务卡片（应付 + 应收合并）：进入债务页
  tapDebt() {
    wx.navigateTo({ url: '/pages/debt-list/debt-list' })
  },
  // 待报销：进入报销账户列表
  tapReimburse() {
    wx.navigateTo({ url: '/pages/debt-list/debt-list?kind=reimburse' })
  },
  // 定期存款：进入定存记录页（账户详情「⋮」菜单里的「定期存款」也进同一页）
  tapDeposit() {
    wx.navigateTo({ url: '/pages/deposit-list/deposit-list' })
  }
})
