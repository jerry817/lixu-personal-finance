// pages/deposit-list/deposit-list.js 定存记录（设计图 1）：
//   入口：
//     · 账户详情页右上角「⋮」菜单里的「定期存款」：带 accountId，只显示该账户的定存，新增时存入账户锁定为该账户；
//     · 账户页「定期存款」卡片：不带 accountId，显示所有账户的定存。
//   右上角「＋」→ 定期存款表单（pages/deposit-edit，设计图 2）；点一条记录 → 查看 / 编辑。
const store = require('../../utils/store')
const util = require('../../utils/util')
const dep = require('../../utils/deposit')

Page({
  data: {
    statusBarHeight: 20,
    navH: 44,
    moreRight: 16,
    loaded: false,
    accountId: '', // 从账户详情进入时的账户：只显示它的定存，新增定存时存入账户锁定为它；空 = 全部账户
    principalText: '0.00',
    incomeText: '0.00',
    countText: '',
    scopeText: '', // 从账户详情进入时的账户名（标题下提示「仅显示该账户」）
    active: [],   // 进行中
    done: []      // 已到期
  },

  onLoad(options) {
    const w = wx.getWindowInfo()
    const sb = w.statusBarHeight || 20
    let navH = 44
    let moreRight = 16
    try {
      // 「＋」放在微信胶囊按钮左侧，不被原生胶囊遮挡
      const mb = wx.getMenuButtonBoundingClientRect()
      if (mb && mb.height) {
        navH = (mb.top - sb) * 2 + mb.height
        moreRight = Math.round(w.windowWidth - mb.left + 8)
      }
    } catch (e) { /* 取不到胶囊就用默认值 */ }
    this.setData({ statusBarHeight: sb, navH, moreRight, accountId: (options && options.accountId) || '' })
  },

  onShow() { this.refresh() },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  refresh() {
    store.postDepositIncome() // 有到期的先把收益账单记上，下面的状态才是最新的
    const today = util.dateStr()
    const active = []
    const done = []
    const accId = this.data.accountId
    store.getDeposits(accId).forEach(d => {
      const left = dep.daysLeft(d.maturityDate, today)
      const acc = d.accountId && store.getAccount(d.accountId)
      const row = {
        id: d.id,
        account: acc ? acc.name : (d.account || ''), // 存入账户（账户被删了就用记录里存的名字）
        amountText: util.money(d.amount),
        incomeText: '+' + util.money(d.income),
        rateTerm: '年利率 ' + util.trimZero(d.rate) + '% · 存期 ' + dep.termText(d.term, d.unit),
        range: d.startDate + ' → ' + d.maturityDate,
        remark: d.remark || ''
      }
      if (d.withdrawn) {
        row.tag = '已提前支取'
        row.tagCls = 'off'
        row.sub = d.withdrawInterest > 0 ? '支取收益 +' + util.money(d.withdrawInterest) + ' 已入账' : '提前支取，无收益'
        row.incomeText = '+' + util.money(d.withdrawInterest || 0)
        row.sort = d.withdrawDate || d.maturityDate
        done.push(row)
      } else if (left > 0) {
        row.tag = left === 1 ? '明天到期' : '还剩 ' + left + ' 天'
        row.tagCls = 'on'
        row.sub = ''
        row.sort = d.maturityDate
        active.push(row)
      } else {
        row.tag = '已到期'
        row.tagCls = 'off'
        row.sub = d.billed && Number(d.income) > 0 ? '收益已入账' : ''
        row.sort = d.maturityDate
        done.push(row)
      }
    })
    active.sort((a, b) => (a.sort < b.sort ? -1 : 1)) // 最先到期的排前面
    done.sort((a, b) => (a.sort < b.sort ? 1 : -1))   // 最近到期的排前面
    const sum = store.depositSummary(accId)
    this.setData({
      loaded: true,
      principalText: util.money(sum.principal),
      incomeText: util.money(sum.income),
      countText: sum.count ? '共 ' + sum.count + ' 笔在存' : '',
      scopeText: accId ? ((store.getAccount(accId) || {}).name || '') : '',
      active,
      done
    })
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/account/account' }) })
  },

  addDeposit() {
    wx.navigateTo({ url: '/pages/deposit-edit/deposit-edit' + (this.data.accountId ? '?accountId=' + this.data.accountId : '') })
  },

  tapRow(e) {
    wx.navigateTo({ url: '/pages/deposit-edit/deposit-edit?id=' + e.currentTarget.dataset.id })
  }
})
