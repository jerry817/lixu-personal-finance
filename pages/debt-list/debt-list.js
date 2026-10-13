// pages/debt-list/debt-list.js 债务页：
//   默认（kind 缺省）= 「债务」：应付款/借入 + 应收款/借出 两个分组卡（账户页「债务」卡片入口）；
//   kind=reimburse = 报销账户列表（账户页「待报销」卡片入口）
const store = require('../../utils/store')
const util = require('../../utils/util')

// 分组：tone 决定分组合计 / 账户余额的颜色
const GROUP_META = {
  payable: { label: '应付款/借入', tone: 'red', empty: '暂无借入账户，点击添加' },
  receivable: { label: '应收款/借出', tone: 'green', empty: '暂无借出账户，点击添加' },
  reimburse: { label: '报销', tone: '', empty: '暂无账户，点击添加' }
}
const KINDS_BY_MODE = {
  all: ['payable', 'receivable'],
  reimburse: ['reimburse']
}

Page({
  data: {
    mode: 'all',        // all（债务）| reimburse（报销账户）
    payableText: '0.00',
    receivableText: '0.00',
    pendingText: '0.00', // 报销：待报销
    doneText: '0.00',    // 报销：已报销
    groups: [],
    fold: {}             // 分组折叠状态：{ payable: true, ... }
  },

  onLoad(o) {
    const mode = o.kind === 'reimburse' ? 'reimburse' : 'all'
    this.setData({ mode })
    wx.setNavigationBarTitle({ title: mode === 'reimburse' ? '报销账户' : '债务' })
  },

  onShow() { this.refresh() },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  refresh() {
    const mode = this.data.mode
    const groups = KINDS_BY_MODE[mode].map(kind => {
      const meta = GROUP_META[kind]
      const sum = store.debtSummary(kind)
      return {
        kind, label: meta.label, tone: meta.tone, empty: meta.empty,
        totalText: util.money(sum.pending),
        rows: store.getDebtViews(kind).map(v => ({
          id: v.id, name: v.name, icon: v.icon, pendingText: util.money(v.pending)
        }))
      }
    })
    const patch = { groups }
    if (mode === 'reimburse') {
      const sum = store.debtSummary('reimburse')
      patch.pendingText = util.money(sum.pending)
      patch.doneText = util.money(sum.done)
    } else {
      patch.payableText = util.money(store.debtSummary('payable').pending)
      patch.receivableText = util.money(store.debtSummary('receivable').pending)
    }
    this.setData(patch)
  },

  toggleGroup(e) {
    const kind = e.currentTarget.dataset.kind
    this.setData({ ['fold.' + kind]: !this.data.fold[kind] })
  },

  tapAccount(e) {
    wx.navigateTo({ url: '/pages/account-detail/account-detail?id=' + e.currentTarget.dataset.id })
  },

  // 添加账户：点分组里的空态行 → 直接加该品类；点底部「添加账户」→ 债务页先选借入 / 借出
  addAccount(e) {
    const kind = e && e.currentTarget.dataset.kind
    if (kind) { this.goEdit(kind); return }
    if (this.data.mode === 'reimburse') { this.goEdit('reimburse'); return }
    wx.showActionSheet({
      itemList: [GROUP_META.payable.label, GROUP_META.receivable.label],
      success: res => this.goEdit(res.tapIndex === 0 ? 'payable' : 'receivable')
    })
  },

  goEdit(kind) {
    wx.navigateTo({ url: '/pages/account-edit/account-edit?group=debt&kind=' + kind })
  }
})
