// pages/bill-detail/bill-detail.js 账单详情
// 卡片：分类 / 金额 → 日期 · 账户（· 报销账户 · 报销详情）→ 备注 · 标签 · 附件 · 不计入收支 · 不计入预算 → 账本 · 地点 · 记录时间 · 记录方式
// 底部：退款 / 报销 / 编辑。报销：账单选了报销账户才显示「报销账户 / 报销详情」与「报销」按钮，勾选「结束报销」保存后按钮消失。
const store = require('../../utils/store')
const util = require('../../utils/util')
const cats = require('../../utils/categories')
const cloud = require('../../utils/cloud')
const kinds = require('../../utils/accountKinds')

const pad = util.pad

// 2026-10-01 -> 2026年10月01日
function cnDate(d) {
  const p = String(d).split('-')
  return p[0] + '年' + p[1] + '月' + p[2] + '日'
}

function cnDateTime(ts) {
  const t = new Date(ts)
  return t.getFullYear() + '年' + pad(t.getMonth() + 1) + '月' + pad(t.getDate()) + '日 ' + pad(t.getHours()) + ':' + pad(t.getMinutes())
}

function dateLabel(date) {
  if (date === util.dateStr()) return '今天'
  const p = date.split('-')
  return Number(p[1]) + '月' + Number(p[2]) + '日'
}

const VIA = { manual: '手动记账', ai: '智能记账' }

Page({
  data: {
    id: '',
    statusBarHeight: 20,
    navH: 44,
    moreRight: 16,

    // 卡片 1：分类 / 金额
    title: '',
    icon: '',
    amount: '',
    amountClass: 'c-dark',
    origAmountText: '',     // 有退款 / 报销到账冲减时显示原额

    // 卡片 2：日期 / 账户 / 报销
    dateText: '',
    accPick: false,         // 收支账户选择器
    accPickList: [],
    accPickId: '',
    accRows: [],            // [{ label, name, icon, id }]
    refundAmountText: '',   // 商家退款金额（报销到账不算）
    reimb: null,            // { accountName, receivedText, done }
    reimbBtn: false,        // 是否显示底部「报销」按钮

    // 卡片 3
    remark: '',
    tag: '',
    attachments: [],
    cloudOn: false,         // 已登录：只有云端副本（fileID）的附件才能显示缩略图（云功能，未登录不显示）
    noCount: false,
    noBudget: false,
    showCount: false,       // 收入 / 支出才有「不计入收支」
    showBudget: false,      // 只有支出有「不计入预算」

    // 卡片 4
    ledger: '日常账本',
    location: '',
    createText: '',
    viaText: '手动记账',

    showRefund: false,

    // 备注 / 标签编辑弹窗
    dlg: false,
    dlgKind: '',
    dlgTitle: '',
    dlgValue: '',
    dlgTags: [],

    // 报销弹窗（报销信息）
    rb: false,
    rbAmount: '',
    rbRemark: '',
    rbFinish: false,
    rbDate: '',
    rbDateLabel: '今天',
    rbAccId: '',
    rbAccName: '',
    rbAccIcon: '',
    rbRemain: 0,
    rbAccSheet: false,
    rbAccounts: []
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

  onShow() {
    if (this.data.id) this.load()
  },

  // 其它设备的改动同步到本机后由 App 调用：这笔账单在别处被改了就刷新；被删了就提示并退出（load 会静默退出）
  onDataChanged() {
    if (!this.data.id) return
    if (!store.getBill(this.data.id)) wx.showToast({ title: '该账单已在其他设备删除', icon: 'none' })
    this.load()
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) })
  },

  // ------------------------------------------------------------ 载入
  accInfo(id, name) {
    const acc = (id && store.getAccount(id)) || (name && store.getAccounts(true).find(a => a.name === name)) || null
    return { id: acc ? acc.id : '', name: acc ? acc.name : (name || '无账户'), icon: acc ? acc.icon : '' }
  },

  load() {
    const b = store.getBill(this.data.id)
    if (!b) { wx.navigateBack(); return }
    const c = store.getCat(b.catId, b.type)
    let title = c ? c.label : ''
    let amount = util.money(b.amount)
    let amountClass = 'c-dark'
    let icon = c ? cats.iconPath(c.icon, false) : ''
    const label = c ? c.label : '未分类' // 分类被删除后账单仍要能打开
    if (b.type === 'expense') {
      title = label + (b.sub ? ' · ' + b.sub : '')
      amount = '-' + util.money(store.effectiveExpense(b)); amountClass = 'c-red'
    } else if (b.type === 'income') {
      title = label + (b.sub ? ' · ' + b.sub : '')
      amount = '+' + util.money(b.amount); amountClass = 'c-green'
    } else if (b.type === 'transfer') {
      title = '账户转账'
      icon = '/images/ui/exchange.png'
    } else if (b.type === 'debt') {
      title = label
      const inflow = b.catId === 'borrow' || b.catId === 'collect'
      amount = (inflow ? '+' : '-') + util.money(b.amount)
      amountClass = inflow ? 'c-green' : 'c-red'
    }

    const accRows = b.type === 'transfer'
      ? [Object.assign({ label: '转出账户' }, this.accInfo(b.accountId, b.account)),
        Object.assign({ label: '转入账户' }, this.accInfo(b.toAccountId, b.toAccount))]
      : [Object.assign({ label: '收支账户', pick: true }, this.accInfo(b.accountId, b.account))] // 收支账户：点击弹出账户选择

    // 转账手续费 / 债务对象与还款日期：只在有值时显示
    const extraRows = []
    if (store.billFee(b) > 0) {
      extraRows.push({ label: '手续费', val: util.money(store.billFee(b)) })
    }
    if (b.type === 'debt') {
      if (b.debtAccount) extraRows.push({ label: '债务账户', val: b.debtAccount })
      // 借出对应「收款日期」，借入对应「还款日期」
      if (b.repayDate) extraRows.push({ label: b.catId === 'lend' ? '收款日期' : '还款日期', val: cnDate(b.repayDate) })
    }

    // 日期：账单日期 + 记账时间（旧账单没有时间就只显示日期）
    const dateText = cnDate(b.date) + (b.time ? ' ' + b.time : '')

    const info = store.reimburseInfo(b)
    const merchantRefund = Math.round((store.refundTotal(b) - store.reimbursedTotal(b)) * 100) / 100

    this.setData({
      title, icon, amount, amountClass,
      origAmountText: b.type === 'expense' && store.refundTotal(b) > 0 ? util.money(b.amount) : '',
      dateText, accRows, extraRows,
      refundAmountText: b.type === 'expense' && merchantRefund > 0 ? util.money(merchantRefund) : '',
      reimb: info ? {
        accountName: info.accountName,
        receivedText: '已报销 ' + util.money(info.received) + (info.done ? '（已结束）' : ''),
        done: info.done
      } : null,
      reimbBtn: !!(info && info.canReimburse),
      remark: b.remark || '',
      tag: b.tag || '',
      attachments: b.attachments || [],
      cloudOn: cloud.isLoggedIn(),
      noCount: !!b.noCount,
      noBudget: !!b.noBudget,
      showCount: b.type === 'expense' || b.type === 'income',
      showBudget: b.type === 'expense',
      location: b.location && b.location.name ? b.location.name : '',
      createText: cnDateTime(b.createTime),
      viaText: VIA[b.via] || VIA.manual,
      showRefund: b.type !== 'debt'
    })
  },

  // ------------------------------------------------------------ 导航
  // 账户行：「收支账户」点击弹出账户选择器；转账的转出 / 转入账户仍是进入该账户详情
  tapAccRow(e) {
    const { id, pick } = e.currentTarget.dataset
    if (pick) { this.openAccPick(); return }
    if (id) wx.navigateTo({ url: '/pages/account-detail/account-detail?id=' + id })
  },

  // ------------------------------------------------------------ 收支账户选择
  // 候选：非债务分组的账户（与记账页一致）+「无账户」（只记账单、不动任何账户余额）
  openAccPick() {
    const b = store.getBill(this.data.id)
    if (!b) return
    const bills = store.getBillsSync()
    const list = store.getAccounts(false)
      .filter(a => kinds.groupOf(a) !== 'debt')
      .map(a => ({ id: a.id, name: a.name, icon: a.icon, balance: util.money(store.availableBalance(a.id, bills)) }))
    list.unshift({ id: '', name: '无账户', icon: '', noAcc: true, balance: '' })
    const cur = store.accIdOf(b, 'from')
    this.setData({ accPick: true, accPickList: list, accPickId: cur && store.getAccount(cur) ? cur : '' })
  },

  closeAccPick() { this.setData({ accPick: false }) },

  pickAccPick(e) {
    const id = e.currentTarget.dataset.id
    const b = store.getBill(this.data.id)
    this.setData({ accPick: false })
    if (!b || id === this.data.accPickId) return
    const acc = id ? store.getAccount(id) : null
    const patch = { accountId: acc ? acc.id : '', account: acc ? acc.name : '' }
    if (b.type === 'debt') {
      // 借入 / 借出：有账户 = 生成账单（计入收支），无账户 = 只调整债务账户余额（不计收支）。
      // 新增债务账户时生成的初始账单（有债务账户、不带 debtLink）的「计入收支」是账户页单独设定的，不跟着账户走
      const initial = !!b.debtAccountId && !b.debtLink
      if (!initial) patch.noCount = !acc
      if (!acc) patch.fee = 0 // 手续费从资金账户扣，没有账户就没有手续费
    }
    store.updateBill(this.data.id, patch)
    wx.showToast({ title: '已更换账户', icon: 'success' })
    this.load()
  },

  goReimbDetail() {
    wx.navigateTo({ url: '/pages/reimburse/reimburse?id=' + this.data.id })
  },

  goRefundList() {
    wx.navigateTo({ url: '/pages/refund/refund?id=' + this.data.id })
  },

  edit() {
    wx.redirectTo({ url: '/pages/add/add?edit=' + this.data.id })
  },

  openMore() {
    wx.showActionSheet({
      itemList: ['删除账单'],
      itemColor: '#F25350',
      success: () => {
        wx.showModal({
          title: '删除这笔账单？',
          content: '删除后无法恢复',
          confirmColor: '#F25350',
          success: (r) => {
            if (!r.confirm) return
            store.removeBill(this.data.id)
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => this.goBack(), 400)
          }
        })
      }
    })
  },

  // ------------------------------------------------------------ 属性开关（立即保存）
  onCount(e) {
    store.updateBill(this.data.id, { noCount: !!e.detail.value })
    this.load()
  },

  onBudget(e) {
    store.updateBill(this.data.id, { noBudget: !!e.detail.value })
    this.load()
  },

  // ------------------------------------------------------------ 备注 / 标签（底部弹窗编辑）
  openRemark() {
    this.setData({ dlg: true, dlgKind: 'remark', dlgTitle: '备注', dlgValue: this.data.remark, dlgTags: [] })
  },

  openTag() {
    this.setData({
      dlg: true, dlgKind: 'tag', dlgTitle: '标签', dlgValue: this.data.tag,
      dlgTags: store.tagStats().slice(0, 12).map(t => t.tag)
    })
  },

  onDlgInput(e) { this.setData({ dlgValue: e.detail.value }) },
  pickDlgTag(e) { this.setData({ dlgValue: e.currentTarget.dataset.t }) },
  clearDlg() { this.setData({ dlgValue: '' }) },
  closeDlg() { this.setData({ dlg: false }) },

  saveDlg() {
    const v = this.data.dlgValue.trim()
    const patch = this.data.dlgKind === 'tag' ? { tag: v } : { remark: v }
    store.updateBill(this.data.id, patch)
    this.setData({ dlg: false })
    this.load()
  },

  noop() {},

  // ------------------------------------------------------------ 附件
  addAttach() {
    const remain = 9 - this.data.attachments.length
    if (remain <= 0) { wx.showToast({ title: '最多添加 9 个附件', icon: 'none' }); return }
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择图片', '选择文件'],
      success: (res) => {
        if (res.tapIndex === 0) this.pickImage('camera', remain)
        else if (res.tapIndex === 1) this.pickImage('album', remain)
        else this.pickFile(remain)
      }
    })
  },

  pickImage(source, remain) {
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: remain, mediaType: ['image'], sourceType: [source],
        success: (res) => res.tempFiles.forEach(f => this.saveAttachment(f.tempFilePath, 'image', '')),
        fail: () => {}
      })
    } else {
      wx.chooseImage({
        count: remain, sourceType: [source],
        success: (res) => res.tempFilePaths.forEach(p => this.saveAttachment(p, 'image', '')),
        fail: () => {}
      })
    }
  },

  pickFile(remain) {
    if (!wx.chooseMessageFile) {
      wx.showToast({ title: '当前微信版本不支持选择文件', icon: 'none' })
      return
    }
    wx.chooseMessageFile({
      count: remain, type: 'file',
      success: (res) => res.tempFiles.forEach(f => this.saveAttachment(f.path, 'file', f.name)),
      fail: () => {}
    })
  },

  // 存入小程序本地永久目录，避免临时文件被系统回收后失效；多选时每个文件落盘后都基于最新列表追加
  saveAttachment(tempPath, type, name) {
    const push = (path) => {
      const b = store.getBill(this.data.id)
      const list = (b.attachments || []).concat([{
        id: util.genId(), type, path, name: name || (type === 'image' ? '图片' : '文件')
      }])
      store.updateBill(this.data.id, { attachments: list })
      this.load()
    }
    if (wx.saveFile) {
      wx.saveFile({ tempFilePath: tempPath, success: (r) => push(r.savedFilePath), fail: () => push(tempPath) })
    } else {
      push(tempPath)
    }
  },

  previewAttach(e) {
    const att = this.data.attachments.find(a => a.id === e.currentTarget.dataset.id)
    if (att) cloud.previewAttachment(att, this.data.attachments)
  },

  onAttachError(e) {
    const next = cloud.dropStalePath(this.data.attachments, e.currentTarget.dataset.id)
    if (next !== this.data.attachments) this.setData({ attachments: next })
  },

  removeAttach(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除这个附件？',
      confirmColor: '#F25350',
      success: (r) => {
        if (!r.confirm) return
        const b = store.getBill(this.data.id)
        const item = (b.attachments || []).find(a => a.id === id)
        store.updateBill(this.data.id, { attachments: (b.attachments || []).filter(a => a.id !== id) })
        if (item && wx.removeSavedFile && item.path) wx.removeSavedFile({ filePath: item.path, fail: () => {} })
        this.load()
      }
    })
  },

  // ------------------------------------------------------------ 记录地点
  pickLocation() {
    const set = (loc) => { store.updateBill(this.data.id, { location: loc }); this.load() }
    const choose = () => wx.chooseLocation({
      success: (r) => set({ name: r.name || r.address || '', address: r.address || '', latitude: r.latitude, longitude: r.longitude }),
      fail: () => {}
    })
    if (!this.data.location) { choose(); return }
    wx.showActionSheet({
      itemList: ['重新选择', '清除地点'],
      success: (r) => { if (r.tapIndex === 0) choose(); else set(null) }
    })
  },

  // ------------------------------------------------------------ 报销（到账 / 结束报销）
  // 到账金额默认填待报销金额；到账账户默认是这笔账单的支付账户；「结束报销」默认不勾
  openReimb() {
    const b = store.getBill(this.data.id)
    const info = store.reimburseInfo(b)
    if (!info || !info.canReimburse) return
    const bills = store.getBillsSync()
    const accounts = store.getAccounts(false)
      .filter(a => kinds.groupOf(a) !== 'debt') // 报销到账进资金 / 信贷等真实账户，不进「债务」类
      .map(a => ({ id: a.id, name: a.name, icon: a.icon, balance: util.money(store.accountBalance(a.id, bills)) }))
    const def = accounts.find(a => a.id === b.accountId) || accounts[0] || { id: '', name: '', icon: '' }
    this.setData({
      rb: true, rbAmount: String(info.remain), rbRemark: '', rbFinish: false,
      rbDate: util.dateStr(), rbDateLabel: '今天',
      rbAccId: def.id, rbAccName: def.name, rbAccIcon: def.icon,
      rbRemain: info.remain, rbAccounts: accounts, rbAccSheet: false
    })
  },

  closeReimb() { this.setData({ rb: false, rbAccSheet: false }) },

  onRbAmount(e) {
    const v = e.detail.value
    if (/^\d*\.?\d{0,2}$/.test(v)) { this.setData({ rbAmount: v }); return }
    return this.data.rbAmount // 非法输入：回退到上一个合法值
  },

  clearRbAmount() { this.setData({ rbAmount: '' }) },
  onRbRemark(e) { this.setData({ rbRemark: e.detail.value }) },
  onRbFinish(e) { this.setData({ rbFinish: !!e.detail.value }) },

  onRbDate(e) {
    const d = e.detail.value
    this.setData({ rbDate: d, rbDateLabel: dateLabel(d) })
  },

  openRbAcc() { this.setData({ rbAccSheet: true }) },
  closeRbAcc() { this.setData({ rbAccSheet: false }) },

  pickRbAcc(e) {
    const a = this.data.rbAccounts.find(x => x.id === e.currentTarget.dataset.id)
    if (a) this.setData({ rbAccId: a.id, rbAccName: a.name, rbAccIcon: a.icon, rbAccSheet: false })
  },

  saveReimb() {
    const d = this.data
    const err = store.addReimbursement(d.id, {
      amount: d.rbAmount, accountId: d.rbAccId, date: d.rbDate, remark: d.rbRemark, finish: d.rbFinish
    })
    if (err) { wx.showToast({ title: err, icon: 'none' }); return }
    this.setData({ rb: false, rbAccSheet: false })
    wx.showToast({ title: d.rbFinish ? '已记录并结束报销' : '已记录报销', icon: 'success' })
    this.load() // 勾了「结束报销」→ canReimburse 为 false → 「报销」按钮随之消失
  },

  // ------------------------------------------------------------ 退款
  // 支出单 → 进入退款页，退款直接减少该单支出（不新增账单）；收入 / 转账沿用反向账单方式；债务不支持
  refund() {
    const b = store.getBill(this.data.id)
    if (!b) return
    if (b.type === 'expense') {
      // 全额退款后仍允许进入：可修改 / 撤销已记录的退款
      wx.navigateTo({ url: '/pages/refund/refund?id=' + b.id })
      return
    }
    if (b.type === 'debt') {
      wx.showToast({ title: '该类型不支持退款', icon: 'none' })
      return
    }
    wx.showModal({
      title: '确认退款？',
      content: '将按原金额、原账户记一笔反向账单，原账单保留',
      confirmColor: '#45A888',
      success: (res) => {
        if (!res.confirm) return
        let r
        if (b.type === 'income') {
          r = {
            type: 'expense', catId: 'other', amount: b.amount, date: b.date,
            accountId: b.accountId, account: b.account,
            remark: (this.data.title || '收入') + '退款'
          }
        } else {
          r = {
            type: 'transfer', amount: b.amount, date: b.date,
            accountId: b.toAccountId, account: b.toAccount,
            toAccountId: b.accountId, toAccount: b.account,
            remark: '转账退款'
          }
        }
        store.addBill(r)
        wx.showToast({ title: '已退款', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 400)
      }
    })
  }
})
