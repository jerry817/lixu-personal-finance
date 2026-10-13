// pages/deposit-edit/deposit-edit.js 定期存款表单（设计图 2）：新增 / 查看 / 编辑一笔定存。
//   · 存入金额 / 年利率 / 存期（年·月·天）/ 备注 / 存入日期 / 预计收益（单利，实时计算）；
//   · 另有两行辅助信息：到期日期（只读，由存入日 + 存期算出）、存入账户（必选：本金从它的可用余额里扣除，到期收益也记到它）；
//   · 存入时校验可用余额（账本余额 − 该账户在存定存本金）：为负或不够存入金额，提示「余额不足，无法存入」；
//   · 从某个账户详情进来新增时，存入账户锁定为该账户（列表只显示该账户的定存，避免存到别的账户后在列表里「消失」）；
//   · 在存的定存详情页有「提前支取」：本金回到存入账户，用户手动填写已得收益（可为 0）并记一笔收入；
//   · 已到期 / 已提前支取并生成过收益账单的定存只读（金额已入账，要改请去改那笔账单），仍可删除。
const store = require('../../utils/store')
const util = require('../../utils/util')
const kinds = require('../../utils/accountKinds')
const dep = require('../../utils/deposit')

// '2026-10-09' → '2026年10月09日'（与设计图一致）
function cnDate(str) {
  return str ? str.slice(0, 4) + '年' + str.slice(5, 7) + '月' + str.slice(8, 10) + '日' : ''
}

Page({
  data: {
    statusBarHeight: 20,
    navH: 44,
    moreRight: 16,
    id: '',
    locked: false,        // 已到期且收益已入账 / 已提前支取：只读
    lockAcc: false,       // 从账户详情进来新增：存入账户锁定为该账户
    canWithdraw: false,   // 在存中（未到期、未支取）的已有定存：显示「提前支取」
    withdrawn: false,
    withdrawInfo: '',     // 已提前支取：「yyyy-mm-dd 提前支取，收益 y」
    wdSheet: false,
    wdInterest: '',
    amount: '',
    rate: '',
    term: '',
    unit: 'year',
    units: dep.UNITS,
    remark: '',
    startDate: util.dateStr(),
    startText: '',
    maturityText: '',
    incomeText: '0元',
    accountId: '',
    accountName: '',
    accSheet: false,
    accList: []
  },

  onLoad(options) {
    const w = wx.getWindowInfo()
    const sb = w.statusBarHeight || 20
    let navH = 44
    let moreRight = 16
    try {
      // 「✓」放在微信胶囊按钮左侧，不被原生胶囊遮挡
      const mb = wx.getMenuButtonBoundingClientRect()
      if (mb && mb.height) {
        navH = (mb.top - sb) * 2 + mb.height
        moreRight = Math.round(w.windowWidth - mb.left + 8)
      }
    } catch (e) { /* 取不到胶囊就用默认值 */ }
    const patch = { statusBarHeight: sb, navH, moreRight }

    // 存入账户：只列普通账户（资金 / 充值 / 投资理财 / 二手货物），信贷与债务账户不能存定存；
    // 每个账户带上可用余额（编辑时把这笔定存自己占用的本金加回去）
    const d = options.id && store.getDeposit(options.id)
    const bills = store.getBillsSync()
    const accList = store.getAccounts(false)
      .filter(a => !store.isCreditAccount(a) && kinds.groupOf(a) !== 'debt')
      .map(a => ({
        id: a.id, name: a.name, icon: a.icon,
        availText: util.money(store.availableBalance(a.id, bills, d ? d.id : ''))
      }))
    patch.accList = accList

    if (d) {
      const acc = d.accountId && accList.find(a => a.id === d.accountId)
      Object.assign(patch, {
        id: d.id,
        locked: !!d.billed,
        withdrawn: !!d.withdrawn,
        canWithdraw: store.isDepositActive(d),
        withdrawInfo: d.withdrawn
          ? d.withdrawDate + ' 提前支取，收益 ' + util.money(d.withdrawInterest || 0) + (d.withdrawInterest > 0 ? '（已入账）' : '')
          : '',
        amount: String(d.amount),
        rate: String(d.rate),
        term: String(d.term),
        unit: d.unit,
        remark: d.remark || '',
        startDate: d.startDate,
        accountId: acc ? acc.id : '',
        accountName: acc ? acc.name : ''
      })
    } else {
      // 新增：从某个账户的菜单进来就存入该账户（并锁定），否则默认上次手动选过的收支账户，都没有就不选
      const from = options.accountId && accList.find(a => a.id === options.accountId)
      const last = from ? from.id : store.lastAccountId(accList)
      const acc = accList.find(a => a.id === last)
      if (acc) Object.assign(patch, { accountId: acc.id, accountName: acc.name })
      if (from) patch.lockAcc = true
    }
    this.setData(patch, () => this.recalc())
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/account/account' }) })
  },

  // ------------------------------------------------------------ 输入
  // 非法输入回退到上一个合法值（返回值会同步回输入框）
  onAmount(e) {
    const v = e.detail.value
    if (/^\d{0,9}(\.\d{0,2})?$/.test(v)) { this.setData({ amount: v }, () => this.recalc()); return }
    return this.data.amount
  },

  onRate(e) {
    const v = e.detail.value
    if (/^\d{0,3}(\.\d{0,4})?$/.test(v) && !(Number(v) > 100)) { this.setData({ rate: v }, () => this.recalc()); return }
    return this.data.rate
  },

  onTerm(e) {
    const v = e.detail.value
    if (/^\d{0,5}$/.test(v) && !(Number(v) > dep.MAX_TERM[this.data.unit])) {
      this.setData({ term: v }, () => this.recalc())
      return
    }
    return this.data.term
  },

  onRemark(e) { this.setData({ remark: e.detail.value }) },

  pickUnit(e) {
    if (this.data.locked) return
    const unit = e.currentTarget.dataset.unit
    if (unit === this.data.unit) return
    // 换单位后存期超过新单位的上限（如 100 月 → 年）时截到上限，避免算出离谱的到期日
    const max = dep.MAX_TERM[unit]
    const term = Number(this.data.term) > max ? String(max) : this.data.term
    this.setData({ unit, term }, () => this.recalc())
  },

  pickStart(e) {
    this.setData({ startDate: e.detail.value }, () => this.recalc())
  },

  // 到期日 + 预计收益：输入变化即重算
  recalc() {
    const d = this.data
    const maturityDate = dep.calcMaturity(d.startDate, d.term, d.unit)
    const income = dep.calcIncome(d.amount, d.rate, d.term, d.unit)
    this.setData({
      startText: cnDate(d.startDate),
      maturityText: cnDate(maturityDate),
      incomeText: util.trimZero(util.money(income)) + '元'
    })
  },

  // ------------------------------------------------------------ 存入账户
  openAcc() {
    if (this.data.locked || this.data.lockAcc) return
    this.setData({ accSheet: true })
  },
  closeAcc() { this.setData({ accSheet: false }) },
  pickAcc(e) {
    const id = e.currentTarget.dataset.id
    const a = this.data.accList.find(x => x.id === id)
    this.setData({ accountId: a ? a.id : '', accountName: a ? a.name : '', accSheet: false })
  },
  noop() {},

  // ------------------------------------------------------------ 保存 / 删除
  save() {
    if (this._saving || this.data.locked) return
    const d = this.data
    const amount = Number(d.amount)
    const rate = Number(d.rate)
    const term = Math.floor(Number(d.term))
    if (!(amount > 0)) { wx.showToast({ title: '请输入存入金额', icon: 'none' }); return }
    if (!(rate > 0)) { wx.showToast({ title: '请输入年利率', icon: 'none' }); return }
    if (!(term > 0)) { wx.showToast({ title: '请输入存期', icon: 'none' }); return }
    if (!d.accountId) { wx.showToast({ title: '请选择存入账户', icon: 'none' }); return }
    const maturityDate = dep.calcMaturity(d.startDate, term, d.unit)
    const income = dep.calcIncome(amount, rate, term, d.unit)
    // 可用余额校验：已经到期的（存入日很早）不占用余额，不校验；编辑时把这笔定存自己占用的本金排除
    if (maturityDate > util.dateStr()) {
      const chk = store.checkDepositFunds(d.accountId, Math.round(amount * 100) / 100, d.id)
      if (!chk.ok) { wx.showToast({ title: '余额不足，无法存入', icon: 'none' }); return }
    }
    const data = {
      amount: Math.round(amount * 100) / 100,
      rate, term, unit: d.unit,
      remark: d.remark.trim(),
      startDate: d.startDate,
      maturityDate,
      income,
      accountId: d.accountId,
      account: d.accountName
    }
    if (d.id) data.id = d.id
    const saved = store.saveDeposit(data)
    if (saved && d.accountId) store.setLastAccountId(d.accountId)
    // 存入日期很早、保存时就已到期的：马上补记收益账单
    const posted = store.postDepositIncome()
    this._saving = true
    wx.showToast({ title: posted ? '已保存，收益账单已生成' : '已保存', icon: posted ? 'none' : 'success' })
    setTimeout(() => wx.navigateBack(), posted ? 900 : 400)
  },

  // ------------------------------------------------------------ 提前支取
  openWithdraw() {
    if (!this.data.canWithdraw) return
    this.setData({ wdSheet: true, wdInterest: '' })
  },
  closeWithdraw() { this.setData({ wdSheet: false }) },
  onWdInterest(e) {
    const v = e.detail.value
    if (/^\d{0,9}(\.\d{0,2})?$/.test(v)) { this.setData({ wdInterest: v }); return }
    return this.data.wdInterest
  },
  confirmWithdraw() {
    if (this._saving) return
    const d = this.data
    // 收益手动填写：留空按 0 处理（提前支取常常只拿活期利息或没有收益）
    const interest = d.wdInterest === '' ? 0 : Number(d.wdInterest)
    if (!(interest >= 0)) { wx.showToast({ title: '请输入正确的收益', icon: 'none' }); return }
    const r = store.withdrawDeposit(d.id, interest)
    if (!r.ok) {
      wx.showToast({ title: '这笔定存已不能提前支取', icon: 'none' })
      this.setData({ wdSheet: false })
      return
    }
    this._saving = true
    this.setData({ wdSheet: false })
    wx.showToast({ title: r.billed ? '已提前支取，收益已入账' : '已提前支取', icon: 'none' })
    setTimeout(() => wx.navigateBack(), 900)
  },

  remove() {
    const d = this.data
    wx.showModal({
      title: '删除定存',
      content: d.locked
        ? '删除这条定存记录？已生成的收益账单会保留，需要的话请到账单里单独删除。'
        : '删除这条定存记录？本金会回到存入账户的可用余额。',
      confirmColor: '#F25350',
      success: res => {
        if (!res.confirm) return
        store.removeDeposit(d.id)
        this._saving = true
        wx.showToast({ title: '已删除', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 400)
      }
    })
  }
})
