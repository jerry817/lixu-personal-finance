// pages/account-edit/account-edit.js 新增 / 编辑账户
const store = require('../../utils/store')
const kinds = require('../../utils/accountKinds')
const util = require('../../utils/util')

// 老账户没有 kind 字段：由 type 反推（仅用于展示/重新推导 type 时的品类）
const LEGACY_KIND = { cash: 'cash', wechat: 'wechat', alipay: 'alipay', bank: 'bank', credit: 'credit' }

// 债务两品类（应付款/借入、应收款/借出）的动态文案；报销账户无金额/日期/资金账户
// 日期 / 资金账户 / 生成账单属于「每一笔」：只在新增账户时填写（对应初始那一笔账单），编辑已有账户时不出现，之后的每一笔在记账页记
const DEBT_TEXTS = {
  payable: {
    namePh: '请输入出借人姓名',
    amountPh: '初始金额，没有可填 0',
    occurLabel: '借入日期',
    occurPh: '借入日期，选填',
    duePh: '还款日期，选填',
    fundLabel: '资金到账账户',
    fundHint: '资金到账账户：钱计入该账户余额，不选则不动任何账户的余额。是否同步生成借入账单、计入收支，由下方开关单独决定。',
    genBillLabel: '生成借入账单'
  },
  receivable: {
    namePh: '请输入借款人姓名',
    amountPh: '初始金额，没有可填 0',
    occurLabel: '借出日期',
    occurPh: '选择日期，选填',
    duePh: '选择日期，选填',
    fundLabel: '资金支出账户',
    fundHint: '资金支出账户：钱从该账户扣除，不选则不动任何账户的余额。是否同步生成借出账单、计入收支，由下方开关单独决定。',
    genBillLabel: '生成借出账单'
  }
}

// 报销账户没有金额 / 日期 / 资金账户；离开债务分组时也要把这些专属字段清空
const EMPTY_DEBT = {
  amount: '', occurDate: '', dueDate: '', fundAccountId: '', fundAccountName: '', genBill: false,
  namePh: '', amountPh: '', occurLabel: '', occurPh: '', duePh: '', fundLabel: '', fundHint: '', genBillLabel: ''
}

// 出账日 / 还款日选择器：第 0 项「不设置」，其余即每月几号
const DAY_RANGE = ['不设置'].concat(Array.from({ length: 31 }, (_, i) => (i + 1) + '日'))

// 「年费设置」行的展示文案
function feeLabel(amount, date) {
  return Number(amount) > 0 && date ? '¥' + amount + '，每年' + Number(date.slice(5, 7)) + '月' + Number(date.slice(8)) + '日' : ''
}

// 债务表单「所属分组」展示名（与设计图一致：报销账户显示「报销」）
const DEBT_KIND_DISPLAY = { payable: '应付款/借入', receivable: '应收款/借出', reimburse: '报销' }

Page({
  data: {
    id: '',
    group: 'fund',
    groupLabel: '资金账户',
    kind: 'custom',
    name: '',
    initial: '',
    alias: '',
    remark: '',
    cardNo: '',
    icon: '',
    inTotal: true,
    isCredit: false,

    // ---------- 信贷分组专属 ----------
    limit: '',            // 总额度
    shareWith: '',        // 共享额度的账户 id（空 = 不共享），此时总额度取对方的
    shareName: '',
    shareLimit: '',
    billDay: 0,           // 每月出账日 / 还款日，0 = 未设置
    repayDay: 0,
    dayRange: DAY_RANGE,
    nextPeriod: true,     // 出账日消费计入下一期
    feeAmount: '',        // 年费金额与首次扣费日；金额为空 = 无年费
    feeDate: '',
    feeText: '',
    shareSheet: false,
    shareList: [],
    feeSheet: false,
    feeAmountInput: '',
    feeDateInput: '',
    today: util.dateStr(), // 扣费日不能早于今天，否则会一次补记好几年的年费

    iconSheet: false,
    icons: kinds.allIcons(),

    // ---------- 债务分组专属 ----------
    amount: '',
    occurDate: '',
    dueDate: '',
    fundAccountId: '',
    fundAccountName: '',
    genBill: false,       // 「生成借入 / 借出账单」开关：与资金账户相互独立
    attachments: [],
    namePh: '',
    amountPh: '',
    occurLabel: '',
    occurPh: '',
    duePh: '',
    fundLabel: '',
    fundHint: '',
    genBillLabel: '',
    groupDisplay: ''
  },

  onLoad(options) {
    if (options.id) {
      const acc = store.getAccount(options.id)
      if (!acc) return
      const group = kinds.groupOf(acc)
      this._origType = acc.type
      this._origGroup = group
      const patch = {
        id: acc.id,
        group,
        groupLabel: kinds.getGroup(group).label,
        kind: acc.kind || LEGACY_KIND[acc.type] || 'custom',
        name: acc.name,
        // 信贷账户的输入框是「欠款」（欠款正数、存款负数），余额为负 = 欠款
        initial: acc.initial ? String(group === 'credit' ? -acc.initial : acc.initial) : '',
        alias: acc.alias || '',
        remark: acc.remark || '',
        cardNo: acc.cardNo || '',
        icon: acc.icon,
        inTotal: acc.inTotal !== false,
        isCredit: group === 'credit'
      }
      if (group === 'debt') Object.assign(patch, this.debtEditPatch(acc))
      if (group === 'credit') Object.assign(patch, this.creditEditPatch(acc))
      this.setData(patch)
      wx.setNavigationBarTitle({ title: '编辑账户' })
    } else {
      const group = kinds.getGroup(options.group).key
      const k = kinds.getKind(group, options.kind)
      const patch = {
        group,
        groupLabel: kinds.getGroup(group).label,
        kind: k.key,
        name: k.key === 'custom' ? '' : k.label, // 预设品类直接带出名称，自定义留空
        icon: k.icon,
        isCredit: group === 'credit'
      }
      if (group === 'debt') {
        // 债务账户名称需手动填写（对方姓名/报销账户名），不预填品类名
        patch.name = ''
        patch.groupDisplay = DEBT_KIND_DISPLAY[k.key] || '债务'
        Object.assign(patch, DEBT_TEXTS[k.key] || {})
      }
      this.setData(patch)
      // 债务分组标题用品类名（新增应付款/借入 等），信贷分组「新增信用卡账户」，其余用分组名
      const title = group === 'debt' ? k.label : (group === 'credit' ? k.label + '账户' : kinds.getGroup(group).label)
      wx.setNavigationBarTitle({ title: '新增' + title })
    }
  },

  // 编辑信贷账户时的字段回填
  creditEditPatch(acc) {
    const host = acc.shareWith && store.getAccount(acc.shareWith)
    const fee = acc.annualFee
    return {
      limit: acc.limit ? String(acc.limit) : '',
      shareWith: host ? host.id : '',
      shareName: host ? host.name : '',
      shareLimit: host && host.limit ? util.money(host.limit) : '',
      billDay: acc.billDay || 0,
      repayDay: acc.repayDay || 0,
      nextPeriod: acc.nextPeriod !== false,
      feeAmount: fee ? String(fee.amount) : '',
      feeDate: fee ? fee.date : '',
      feeText: fee ? feeLabel(fee.amount, fee.date) : ''
    }
  },

  // 编辑债务账户时的字段回填
  debtEditPatch(acc) {
    return Object.assign({
      amount: acc.initial ? String(Math.abs(acc.initial)) : '',
      groupDisplay: DEBT_KIND_DISPLAY[acc.kind] || '债务',
      attachments: Array.isArray(acc.attachments) ? acc.attachments : []
    }, DEBT_TEXTS[acc.kind] || {})
  },

  onName(e) { this.setData({ name: e.detail.value }) },
  onAlias(e) { this.setData({ alias: e.detail.value }) },
  onRemark(e) { this.setData({ remark: e.detail.value }) },
  onCardNo(e) { this.setData({ cardNo: e.detail.value }) },

  // 余额：信贷账户允许负数（欠款），其余只允许非负；最多两位小数
  onInitial(e) {
    const re = this.data.isCredit ? /^-?\d*\.?\d{0,2}$/ : /^\d*\.?\d{0,2}$/
    const v = e.detail.value
    if (re.test(v)) { this.setData({ initial: v }); return }
    // 非法输入：回退到上一个合法值（返回值会同步回输入框）
    return this.data.initial
  },

  // 总额度：非负，最多两位小数
  onLimit(e) {
    const v = e.detail.value
    if (/^\d*\.?\d{0,2}$/.test(v)) { this.setData({ limit: v }); return }
    return this.data.limit
  },

  pickDay(e) {
    this.setData({ [e.currentTarget.dataset.key]: Number(e.detail.value) })
  },

  onNextPeriod(e) { this.setData({ nextPeriod: e.detail.value }) },

  // 额度共享：可以挑一个自己不共享别人的信贷账户，共用它的总额度；已有账户在共享本账户时本账户不能再去共享别人
  openShare() {
    const d = this.data
    if (store.getAccounts(true).some(a => a.shareWith === d.id && d.id)) {
      wx.showToast({ title: '已有账户在共享本账户的额度', icon: 'none' })
      return
    }
    const shareList = store.getAccounts(true)
      .filter(a => store.isCreditAccount(a) && a.id !== d.id && !a.shareWith)
      .map(a => ({ id: a.id, name: a.name, icon: a.icon, limit: a.limit ? util.money(a.limit) : '' }))
    this.setData({ shareSheet: true, shareList })
  },
  closeShare() { this.setData({ shareSheet: false }) },
  pickShare(e) {
    const hit = this.data.shareList.find(a => a.id === e.currentTarget.dataset.id)
    this.setData({
      shareSheet: false,
      shareWith: hit ? hit.id : '',
      shareName: hit ? hit.name : '',
      shareLimit: hit ? hit.limit : ''
    })
  },

  // 年费设置：金额 + 首次扣费日，到期日每年自动记一笔支出（见 store.postAnnualFees）
  openFee() {
    this.setData({ feeSheet: true, feeAmountInput: this.data.feeAmount, feeDateInput: this.data.feeDate })
  },
  closeFee() { this.setData({ feeSheet: false }) },
  onFeeAmount(e) {
    const v = e.detail.value
    if (/^\d*\.?\d{0,2}$/.test(v)) { this.setData({ feeAmountInput: v }); return }
    return this.data.feeAmountInput
  },
  pickFeeDate(e) { this.setData({ feeDateInput: e.detail.value }) },
  clearFee() { this.setData({ feeSheet: false, feeAmount: '', feeDate: '', feeText: '' }) },
  confirmFee() {
    const { feeAmountInput: amount, feeDateInput: date } = this.data
    if (!(Number(amount) > 0)) { wx.showToast({ title: '请输入年费金额', icon: 'none' }); return }
    if (!date) { wx.showToast({ title: '请选择扣费日期', icon: 'none' }); return }
    this.setData({ feeSheet: false, feeAmount: amount, feeDate: date, feeText: feeLabel(amount, date) })
  },

  // 债务初始金额：非负，最多两位小数（保存时按品类映射正负）
  onAmount(e) {
    const v = e.detail.value
    if (/^\d*\.?\d{0,2}$/.test(v)) { this.setData({ amount: v }); return }
    return this.data.amount
  },

  onInTotal(e) { this.setData({ inTotal: e.detail.value }) },
  onGenBill(e) { this.setData({ genBill: e.detail.value }) },

  pickOccurDate(e) {
    if (e.detail.value) this.setData({ occurDate: e.detail.value })
  },

  pickDueDate(e) {
    if (e.detail.value) this.setData({ dueDate: e.detail.value })
  },

  // 资金到账/支出账户：无账户 + 非债务类已有账户
  pickFundAccount() {
    const debtIds = {}
    store.getAccounts(true).forEach(a => { if (kinds.groupOf(a) === 'debt') debtIds[a.id] = 1 })
    const views = store.getAccountViews().filter(v => !debtIds[v.id])
    const items = ['无账户'].concat(views.map(v => v.name))
    wx.showActionSheet({
      itemList: items,
      success: res => {
        // 资金账户只决定钱进出哪个账户；要不要生成账单（计入收支）由「生成借入 / 借出账单」开关单独决定
        const v = views[res.tapIndex - 1]
        this.setData({ fundAccountId: v ? v.id : '', fundAccountName: v ? v.name : '' })
      }
    })
  },

  // ---------------- 附件（与记账页同一模式：拍照/相册/文件，saveFile 持久化）
  addAttachment() {
    const remain = 9 - this.data.attachments.length
    if (remain <= 0) { wx.showToast({ title: '最多添加 9 个附件', icon: 'none' }); return }
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择图片', '选择文件'],
      success: res => {
        if (res.tapIndex === 0) this.pickAttImage(['camera'], remain)
        else if (res.tapIndex === 1) this.pickAttImage(['album'], remain)
        else this.pickAttFile(remain)
      }
    })
  },

  pickAttImage(source, remain) {
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: remain, mediaType: ['image'], sourceType: source,
        success: res => res.tempFiles.forEach(f => this.saveAttachment(f.tempFilePath, 'image', '')),
        fail: () => {}
      })
    } else {
      // 兼容不支持 chooseMedia 的旧基础库
      wx.chooseImage({
        count: remain, sourceType: source,
        success: res => res.tempFilePaths.forEach(p => this.saveAttachment(p, 'image', ''))
      })
    }
  },

  pickAttFile(remain) {
    wx.chooseMessageFile({
      count: remain, type: 'file',
      success: res => res.tempFiles.forEach(f => this.saveAttachment(f.path, 'file', f.name)),
      fail: () => {}
    })
  },

  saveAttachment(tempPath, type, name) {
    const item0 = { id: util.genId(), type, path: tempPath, name: name || '图片' }
    const push = path => {
      const list = this.data.attachments.concat([Object.assign(item0, { path })])
      this.setData({ attachments: list })
    }
    if (wx.saveFile) {
      wx.saveFile({ tempFilePath: tempPath, success: r => push(r.savedFilePath), fail: () => push(tempPath) })
    } else push(tempPath)
  },

  removeAttach(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.attachments.find(a => a.id === id)
    this.setData({ attachments: this.data.attachments.filter(a => a.id !== id) })
    if (item && wx.removeSavedFile) wx.removeSavedFile({ filePath: item.path, fail: () => {} })
  },

  // 债务品类切换时要一起变的字段：品类、展示名、文案；报销账户没有金额 / 日期 / 资金账户，一并清空
  debtKindPatch(kind) {
    return Object.assign(
      { kind, groupDisplay: DEBT_KIND_DISPLAY[kind] },
      kind === 'reimburse' ? EMPTY_DEBT : DEBT_TEXTS[kind]
    )
  },

  // 已有流水的债务账户不能改品类 / 换进换出债务分组：应付 ↔ 应收会让已记的借入、还款方向全部反过来
  guardDebtChange() {
    if (this.data.id && store.accountBills(this.data.id).length) {
      wx.showToast({ title: '已有账单的债务账户不能修改分组', icon: 'none' })
      return true
    }
    return false
  },

  // 所属分组（债务分组）：在三个债务品类间切换
  pickDebtKind() {
    if (this.guardDebtChange()) return
    const dg = kinds.getGroup('debt')
    wx.showActionSheet({
      itemList: dg.kinds.map(k => DEBT_KIND_DISPLAY[k.key]),
      success: res => {
        const k = dg.kinds[res.tapIndex]
        if (!k || k.key === this.data.kind) return
        this.setData(this.debtKindPatch(k.key))
        if (!this.data.id) {
          wx.setNavigationBarTitle({ title: '新增' + (k.key === 'reimburse' ? '报销账户' : k.label) })
        }
      }
    })
  },

  // 所属分组：6 个分组刚好是 showActionSheet 的上限
  pickGroup() {
    wx.showActionSheet({
      itemList: kinds.GROUPS.map(g => g.label),
      success: res => {
        const g = kinds.GROUPS[res.tapIndex]
        if (g) this.setGroup(g.key)
      }
    })
  },

  // 切换分组：分组、品类、图标、名称、债务专属字段必须一次性换完，
  // 否则会留下上一个分组的品类（例如换进债务分组却还是「自定义」品类，保存后既不是应收也不是应付）
  setGroup(key) {
    const d = this.data
    if (key === d.group) return
    if ((key === 'debt' || d.group === 'debt') && this.guardDebtChange()) return
    const g = kinds.getGroup(key)
    const k = g.kinds[0]
    const prev = kinds.getKind(d.group, d.kind)
    const patch = {
      group: key,
      groupLabel: g.label,
      isCredit: key === 'credit',
      kind: k.key,
      icon: this._iconPicked ? d.icon : k.icon, // 手动选过的图标保留
      // 信贷账户输入的是欠款（可为负 = 存款），与其它分组的余额方向相反，跨分组时清空，避免正负号被误读
      initial: (key === 'credit') === d.isCredit ? d.initial : ''
    }
    // 名称还是上一个品类的预设名（没改过）时跟着换；债务账户的名称是对方姓名，不预填
    if (!d.id && (d.name === '' || d.name === prev.label)) patch.name = key === 'debt' || k.key === 'custom' ? '' : k.label
    if (key === 'debt') Object.assign(patch, this.debtKindPatch(k.key))
    else if (d.group === 'debt') Object.assign(patch, EMPTY_DEBT, { groupDisplay: '' })
    this.setData(patch)
  },

  // 账户图标
  openIcons() { this.setData({ iconSheet: true }) },
  closeIcons() { this.setData({ iconSheet: false }) },
  pickIcon(e) {
    this._iconPicked = true
    this.setData({ icon: e.currentTarget.dataset.src, iconSheet: false })
  },
  noop() {},

  showCurrencyTip() {
    wx.showToast({ title: '暂仅支持人民币（CNY）', icon: 'none' })
  },

  save() {
    if (this._saving) return // 保存中（已提示成功、等待返回）不再响应重复点击，避免重复生成账单
    if (this.data.group === 'debt') return this.saveDebt()
    const d = this.data
    const name = d.name.trim()
    if (!name) { wx.showToast({ title: '请输入账户名称', icon: 'none' }); return }
    // 账单靠账户 id（旧数据靠名称）关联账户，重名会导致串账
    if (store.getAccounts(true).some(a => a.id !== d.id && a.name === name)) {
      wx.showToast({ title: '已有同名账户', icon: 'none' }); return
    }
    const initial = Number(d.initial)
    const data = {
      name,
      group: d.group,
      kind: d.kind,
      // 编辑时分组没动 → 保持原 type（老账户的类型不被重新推导）；新增或改了分组 → 按分组/品类推导
      type: d.id && d.group === this._origGroup ? this._origType : kinds.typeOf(d.group, d.kind),
      icon: d.icon,
      initial: isFinite(initial) ? (d.isCredit ? 0 - initial : initial) : 0, // 信贷：欠款 → 负余额（0 - x 避免 -0）
      alias: d.alias.trim(),
      remark: d.remark.trim(),
      cardNo: d.cardNo.trim(),
      inTotal: !!d.inTotal,
      currency: 'CNY'
    }
    if (d.isCredit) {
      Object.assign(data, {
        limit: d.shareWith ? 0 : (Number(d.limit) || 0), // 共享额度时用对方的总额度，自己的不留
        shareWith: d.shareWith,
        billDay: d.billDay,
        repayDay: d.repayDay,
        nextPeriod: !!d.nextPeriod,
        annualFee: d.feeText ? { amount: Number(d.feeAmount), date: d.feeDate } : null
      })
    }
    if (d.id) data.id = d.id
    else data.hidden = false
    store.saveAccount(data)
    if (d.isCredit) store.postAnnualFees() // 年费日已到（或今天）的补记一笔
    this._saving = true
    wx.showToast({ title: '已保存', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 400)
  },

  // 债务分组保存。账户本身新增 / 编辑都存；日期 / 资金账户 / 生成账单只在新增时用来生成初始那一笔账单，
  // 编辑已有账户不动任何账单（之后的每一笔在记账页记）
  saveDebt() {
    const d = this.data
    const name = d.name.trim()
    if (!name) {
      wx.showToast({ title: d.kind === 'reimburse' ? '请输入账户名称' : '请输入姓名', icon: 'none' })
      return
    }
    if (store.getAccounts(true).some(a => a.id !== d.id && a.name === name)) {
      wx.showToast({ title: '已有同名账户', icon: 'none' }); return
    }

    // 初始金额可以为 0（留空也按 0）：应付款/借入=欠款→负余额；应收款/借出=债权→正余额；报销账户没有金额
    const isDebt = d.kind !== 'reimburse'
    const amt = isDebt ? Math.round((Number(d.amount) || 0) * 100) / 100 : 0
    const initial = d.kind === 'payable' ? 0 - amt : amt // 0 - amt：金额为 0 时不出现 -0
    const data = {
      name,
      group: 'debt',
      kind: d.kind,
      type: d.id && d.group === this._origGroup ? this._origType : kinds.typeOf('debt', d.kind),
      icon: d.icon,
      initial,
      alias: '',
      remark: d.remark.trim(),
      cardNo: '',
      inTotal: !!d.inTotal,
      currency: 'CNY',
      attachments: d.attachments.map(a => Object.assign({}, a))
    }
    if (d.id) data.id = d.id
    else data.hidden = false
    const saved = store.saveAccount(data)

    // 新增账户的初始那一笔借入 / 借出账单。资金账户与「生成账单」开关相互独立，四种组合：
    //   账户 ✓ 开关 ✓：账单带账户，钱进出该账户，计入收支；
    //   账户 ✓ 开关 ✗：账单照样生成（账户余额靠它变动），但标「不计收支」，不进借入 / 借出统计；
    //   账户 ✗ 开关 ✓：账单不带账户，只计入收支，不动任何账户余额；
    //   账户 ✗ 开关 ✗：不生成账单。
    // 这笔账单只负责资金账户一侧的现金进出，债务金额已在账户初始余额里，不重复计（不带 debtLink）；初始金额为 0 时没有这一笔
    if (!d.id && amt > 0 && (d.fundAccountId || d.genBill)) {
      store.addBill({
        type: 'debt',
        debtAccountId: saved.id,
        catId: d.kind === 'payable' ? 'borrow' : 'lend',
        amount: amt,
        date: d.occurDate || util.dateStr(),
        accountId: d.fundAccountId,
        account: d.fundAccountId ? d.fundAccountName : '',
        noCount: !d.genBill,
        remark: d.remark.trim(),
        repayDate: d.dueDate,
        attachments: d.attachments.map(a => Object.assign({}, a))
      })
    }

    this._saving = true
    wx.showToast({ title: '已保存', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 400)
  }
})
