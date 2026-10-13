// pages/account-detail/account-detail.js
const util = require('../../utils/util')
const store = require('../../utils/store')
const kinds = require('../../utils/accountKinds')

Page({
  data: {
    statusBarHeight: 20,
    navH: 44,
    moreRight: 16,
    menu: false,
    canDeposit: false, // 「⋮」菜单里的「定期存款」：信贷 / 债务账户不收利息，不显示
    title: '',
    id: '',
    name: '',
    icon: '',
    typeLabel: '',
    balance: '0.00',
    depositText: '',
    neg: false,
    hidden: false,
    groups: [],
    count: 0,
    reimb: null, // 报销账户：绿色汇总卡 + 「添加一条报销」+ 归集到该账户的可报销账单；其余账户为 null
    reimbFilter: 'all', // 报销账户账单筛选：all | pending | done
    debt: null, // 应付款 / 应收款账户：详情页汇总卡 + 操作按钮；其余账户为 null
    credit: null, // 信贷账户：额度汇总卡 + 添加 / 还款 / 转账；其余账户为 null
    statsSheet: false,
    stats: []
  },

  onLoad(options) {
    const w = wx.getWindowInfo()
    const sb = w.statusBarHeight || 20
    let navH = 44
    let moreRight = 16
    try {
      // 「⋮」放在微信胶囊按钮左侧，不被原生胶囊遮挡
      const mb = wx.getMenuButtonBoundingClientRect()
      if (mb && mb.height) {
        navH = (mb.top - sb) * 2 + mb.height
        moreRight = Math.round(w.windowWidth - mb.left + 8)
      }
    } catch (e) { /* 取不到胶囊就用默认值 */ }
    this.setData({ id: options.id, statusBarHeight: sb, navH, moreRight })
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/account/account' }) })
  },

  onShow() {
    this.refresh()
  },

  // 其它设备的改动同步到本机后由 App 调用（utils/store.js 的 onRemoteChange）：重新读取本地数据
  onDataChanged() { this.onShow() },

  refresh() {
    const acc = store.getAccount(this.data.id)
    if (!acc) { this.goBack(); return }
    // 报销账户单独一套视图：它名下的账单是「可报销的支出」（付款账户是别的资金账户），不能按 accountBills 查
    if (store.isReimburseAccount(acc.id)) { this.refreshReimburse(acc); return }
    const bills = store.accountBills(this.data.id)
    const held = store.depositHeld(this.data.id) // 在存定存本金：余额显示可用余额，定存另起一行灰字
    const bal = store.availableBalance(this.data.id, store.getBillsSync())
    const typeMap = { cash: '现金账户', wechat: '微信钱包', alipay: '支付宝', bank: '储蓄卡' }
    // 应付款 / 应收款账户：标题「借入-姓名 / 借出-姓名」，头部换成汇总卡
    const debt = this.debtView(acc)
    const credit = this.creditView(acc)

    // 分组后对转账做方向化处理：转出显示"转出至XX"红色并计支出，
    // 转入显示"从XX转入"绿色并计收入；仅影响本账户统计，不影响总资产收支
    const accId = this.data.id
    const groups = store.groupBills(bills).map(g => {
      let income = g.income
      let expense = g.expense
      const items = g.items.map(it => {
        if (it.raw.type === 'transfer') {
          const fromId = store.accIdOf(it.raw, 'from')
          const toId = store.accIdOf(it.raw, 'to')
          if (fromId === accId) {
            // 手续费由转出账户另付：这一侧实际流出 = 金额 + 手续费
            const fee = store.billFee(it.raw)
            const out = it.raw.amount + fee
            expense += out
            return Object.assign({}, it, {
              title: '转账' + (fee > 0 ? '（含手续费' + util.money(fee) + '）' : ''),
              amount: '-' + util.money(out),
              amountClass: 'amt-red'
            })
          } else if (toId === accId) {
            income += it.raw.amount
            return Object.assign({}, it, {
              title: '转账',
              amount: '+' + util.money(it.raw.amount),
              amountClass: 'amt-green'
            })
          }
        }
        return it
      })
      return Object.assign({}, g, {
        items, income, expense,
        incomeText: util.money(income),
        expenseText: util.money(expense)
      })
    })

    this.setData({
      title: debt ? debt.title : acc.name,
      name: acc.name,
      icon: acc.icon,
      typeLabel: typeMap[acc.type] || '资金账户',
      balance: util.money(bal),
      depositText: held > 0 ? util.money(held) : '',
      neg: bal < 0,
      hidden: !!acc.hidden,
      groups,
      canDeposit: !debt && !credit && kinds.groupOf(acc) !== 'debt',
      count: bills.length,
      reimb: null,
      debt,
      credit
    })
  },

  // ---------------------------------------------------------------- 报销账户
  // 汇总卡：待报销 / 已报销 / 总报销（= 待报销 + 已报销）；列表：按日期分组的可报销账单，
  // 每条标「待报销」（还有钱没报）或「已报销 / 已结束」，右侧金额下方灰字写付款账户；可用「筛选」按状态过滤
  refreshReimburse(acc) {
    const all = store.reimburseBills(acc.id)
    const sum = store.reimburseSummary(acc.id, all)
    const status = b => (store.reimburseAmounts(b).pending > 0.004 ? 'pending' : 'done')
    const f = this.data.reimbFilter
    const bills = all.filter(b => f === 'all' || status(b) === f)
    const groups = store.groupBills(bills).map(g => ({
      date: g.date, md: g.md, week: g.week,
      items: g.items.map(it => {
        const st = status(it.raw)
        // 状态标签以报销进度为准（decorate 只看是否点了「结束报销」）；商家退款 / 不计收支等其它标签保留
        const rest = it.badges.filter(bd => bd.t !== '待报销' && bd.t !== '已报销')
        const own = st === 'pending'
          ? { t: '待报销', cls: 'bd-pend' }
          : { t: store.reimburseAmounts(it.raw).done > 0 ? '已报销' : '已结束', cls: 'bd-done' }
        return Object.assign({}, it, { badges: [own].concat(rest), amountClass: 'amt-dark' })
      })
    }))
    this.setData({
      title: acc.name,
      name: acc.name,
      icon: acc.icon,
      hidden: !!acc.hidden,
      groups,
      count: all.length,
      canDeposit: false,
      debt: null,
      credit: null,
      reimb: {
        pending: util.money(sum.pending),
        done: util.money(sum.done),
        total: util.money(sum.total),
        filterLabel: { all: '', pending: '待报销', done: '已报销' }[f],
        empty: all.length
          ? '没有符合筛选条件的报销账单'
          : '还没有报销账单，点上方「添加一条报销」记一笔'
      }
    })
  },

  // 添加一条报销：进记账页（支出），并直接选中当前报销账户
  addReimbursable() {
    wx.navigateTo({
      url: '/pages/add/add?type=expense&reimburse=1&reimburseAccountId=' + this.data.id
    })
  },

  // 筛选：全部 / 待报销 / 已报销
  openFilter() {
    const keys = ['all', 'pending', 'done']
    wx.showActionSheet({
      itemList: ['全部', '待报销', '已报销'],
      success: res => {
        this.setData({ reimbFilter: keys[res.tapIndex] })
        this.refresh()
      }
    })
  },

  // 债务账户汇总卡的展示模型；非应付款 / 应收款账户返回 null
  debtView(acc) {
    const dd = store.debtDetail(acc.id)
    if (!dd) return null
    const pay = dd.kind === 'payable'
    return {
      title: (pay ? '借入-' : '借出-') + acc.name,
      pendingLabel: pay ? '剩余待还' : '剩余待收',
      pending: util.money(dd.pending),
      doneLabel: pay ? '已还金额' : '已收金额',
      done: util.money(dd.done),
      interestLabel: pay ? '已还利息' : '已收利息',
      interest: util.money(dd.interest),
      nextLabel: pay ? '下次还款' : '下次收款',
      nextDue: dd.nextDue ? dd.nextDue + (dd.overdue ? '（已逾期）' : '') : '未设置',
      appendLabel: pay ? '追加借入' : '追加借出',
      settleLabel: pay ? '还款' : '收款',
      appendCat: pay ? 'borrow' : 'lend',
      settleCat: pay ? 'repay' : 'collect'
    }
  },

  // 信贷账户汇总卡的展示模型；非信贷账户返回 null。owedRaw 给「还款」预填金额用
  creditView(acc) {
    if (!store.isCreditAccount(acc)) return null
    const c = store.creditInfo(acc.id)
    const set = c.limit > 0
    const day = d => d ? '每月' + d + '日' : '未设置'
    return {
      owedLabel: c.surplus > 0 ? '溢缴' : '剩余欠款',
      owed: '¥' + util.money(c.surplus > 0 ? c.surplus : c.owed),
      owedRaw: c.owed,
      limit: set ? util.money(c.limit) : '未设置',
      remaining: set ? util.money(c.remning) : '未设置',
      billDay: day(c.billDay),
      repayDay: day(c.repayDay)
    }
  },

  // 添加（在该卡上记一笔支出）/ 还款（转入该卡，金额预填剩余欠款）/ 转账（从该卡转出）：进记账页并预选账户
  goCreditAction(e) {
    const id = this.data.id
    const owed = this.data.credit.owedRaw
    const query = {
      spend: 'type=expense&accountId=' + id,
      repay: 'type=transfer&toAccountId=' + id + (owed > 0 ? '&amount=' + owed : ''),
      out: 'type=transfer&accountId=' + id
    }[e.currentTarget.dataset.kind]
    wx.navigateTo({ url: '/pages/add/add?' + query })
  },

  // 统计：本月 / 本年 / 累计的消费、还款（转入）、转出
  openStats() {
    const st = store.accountStats(this.data.id)
    const rows = [['month', '本月'], ['year', '本年'], ['all', '累计']].map(([k, label]) => ({
      label, spend: util.money(st[k].spend), repay: util.money(st[k].repay), out: util.money(st[k].out)
    }))
    this.setData({ statsSheet: true, stats: rows })
  },
  closeStats() { this.setData({ statsSheet: false }) },

  // 追加借入 / 借出、还款 / 收款：带着该债务账户和操作进记账页
  goDebtAction(e) {
    const cat = e.currentTarget.dataset.cat
    wx.navigateTo({
      url: '/pages/add/add?type=debt&catId=' + cat + '&debtAccountId=' + this.data.id
    })
  },

  noop() {},

  tapItem(e) {
    wx.navigateTo({ url: '/pages/bill-detail/bill-detail?id=' + e.currentTarget.dataset.id })
  },

  // 顶部「⋮」二级菜单：编辑 / 隐藏 / 删除账户
  openMenu() { this.setData({ menu: true }) },
  closeMenu() { this.setData({ menu: false }) },

  // 定期存款：进定存记录页；带上当前账户，新增定存时默认把到期收益记到这个账户
  openDeposit() {
    this.closeMenu()
    wx.navigateTo({ url: '/pages/deposit-list/deposit-list?accountId=' + this.data.id })
  },

  edit() {
    this.closeMenu()
    wx.navigateTo({ url: '/pages/account-edit/account-edit?id=' + this.data.id })
  },

  toggleHidden() {
    this.closeMenu()
    store.saveAccount({ id: this.data.id, hidden: !this.data.hidden })
    wx.showToast({ title: this.data.hidden ? '已显示' : '已隐藏', icon: 'success' })
    this.refresh()
  },

  del() {
    this.closeMenu()
    if (this.data.count) {
      wx.showModal({
        title: '无法删除',
        content: '该账户下还有 ' + this.data.count + ' 笔账单，请先删除或转移这些账单。',
        showCancel: false
      })
      return
    }
    wx.showModal({
      title: '删除账户“' + this.data.name + '”？',
      confirmColor: '#F25350',
      success: (res) => {
        if (res.confirm) {
          store.removeAccount(this.data.id)
          this.goBack()
        }
      }
    })
  }
})
