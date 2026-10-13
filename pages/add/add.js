// pages/add/add.js
const util = require('../../utils/util')
const store = require('../../utils/store')
const cats = require('../../utils/categories')
const kinds = require('../../utils/accountKinds')
const cloud = require('../../utils/cloud')

const COLS = 5            // 分类网格每行个数（与 wxss .tile 的 20% 宽度对应）
const EDIT_ID = '__edit'  // 一级分类末尾的「编辑」入口

function chunk(list, n) {
  const rows = []
  for (let i = 0; i < list.length; i += n) rows.push(list.slice(i, i + n))
  return rows
}

Page({
  data: {
    types: cats.TYPES,
    curType: 'expense',
    rows: [],        // 一级分类按行（每行 COLS 个）
    selectedId: 'food',
    subPanel: false,
    subRow: -1,      // 二级菜单显示在第几行之后（当前一级分类所在行）
    subs: [],
    selectedSub: '',

    amount: '0',
    btnState: 'cancel', // 右下键三态：cancel(取消→回首页) / done(完成→保存返回) / equal(=→求值)
    remark: '',
    remarkFocus: false, // 备注输入框聚焦态（点击直接在输入框内编辑，不弹窗）
    tag: '',
    reimburse: false,
    // 账单属性：不计入收支（余额照常变动、不进任何统计）/ 不计入预算（只是不占预算额度）
    noCount: false,
    noBudget: false,
    attrSheet: false,
    attachSheet: false,     // 附件二级菜单
    attrCount: false,   // 「账单设置」弹层里的暂存值，点「完成」才生效
    attrBudget: false,
    // 转账 / 债务：账户是否已选择（未选择时卡片显示「请选择…」占位；支出 / 收入恒为 true）
    fromSet: true,
    toSet: true,
    // 债务：债务选择器（借入 / 借出 + 债务分组里的应付款 / 应收款账户）
    debtPicked: false,      // 是否已选择债务
    debtAccountId: '',      // 选中的是具体债务账户时的账户 id（选「借入 / 借出」本身则为空）
    debtAccountName: '',
    debtLink: false,        // 这笔账单是否计入债务账户余额（债务账户「生成账单」产生的账单为 false）
    debtLabel: '',
    debtIcon: '',
    debtDown: true,         // 箭头方向：钱从债务流向账户（借入 / 收款）朝下，从账户流向债务（借出 / 还款）朝上
    debtBalText: '',        // 债务卡片第二行「余额：x」
    debtActions: [],        // 当前债务类型可选的操作：借入 / 还款，或 借出 / 收款
    debtFeeMode: false,     // 还款 / 收款时，第三个 chip 由「还款日期 / 收款日期」换成「手续费」
    genBill: false,         // 生成账单：勾选后同时在所选账户生成收支（资金账户变动）；不勾选只调整债务账户余额
    debtSheet: false,
    debtList: [],
    debtSelKey: '',
    repayDate: '',          // 还款日期（YYYY-MM-DD，选填）
    repayLabel: '',
    // 转账手续费：由转出账户另付，不计入收支 / 预算
    fee: '',
    feeSheet: false,
    feeInput: '',

    date: '',
    dateLabel: '',
    time: '',        // HH:mm（手动选择的记账时间，仅展示用）
    navPadRight: 0,  // 顶部分段右侧需避让微信原生胶囊的距离
    // 日期时间选择底部弹层
    dtSheet: false,
    calTitle: '',
    selDate: '', selTime: '',
    calCells: [],
    accounts: [],
    selectedAccountId: '',
    selectedToAccountId: '',
    accFrom: { name: '', icon: '', noAcc: false },
    accTo: { name: '', icon: '', noAcc: false },
    combineAccounts: [], // 组合支付：≥2 时按选中账户均分金额，分别记一笔
    attachments: [], // 附件：{ id, type: 'image'|'file', path, name }
    cloudOn: false,  // 已登录：只有云端副本（fileID）的附件才能显示（云功能，未登录不显示）

    editId: '',

    // 账户选择二级菜单（单列表，可拖动排序，支持组合支付）
    accSheet: false,
    accRole: 'from',
    accList: [],
    accSelectedId: '',
    accCombine: false,
    accCombineIds: [],
    accDragging: false,
    accDragId: '',

    // 报销账户选择二级菜单
    reimbSheet: false,
    reimbList: [],
    reimburseAccountId: '',
    reimburseAccountName: '',
    reimburseAccountIcon: ''
  },

  onLoad(options) {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const mb = wx.getMenuButtonBoundingClientRect()
    this.setData({
      statusBarHeight: info.statusBarHeight || 20,
      // 分段控件右侧避让微信右上角原生胶囊
      navPadRight: (info.screenWidth || 375) - mb.left + 10
    })
    this.setDate(util.dateStr(), this.nowClock())
    this.initAccounts()
    if (options.edit) {
      this.loadForEdit(options.edit)
      return
    }
    this.switchType(options.type || 'expense')
    if (options.tpl) wx.setNavigationBarTitle({ title: '模板记账' })
    this.applyPrefill(options)
  },

  // 当前时间 HH:mm
  nowClock() {
    const n = new Date()
    return util.pad(n.getHours()) + ':' + util.pad(n.getMinutes())
  },

  // 日期 chip 文案：今天显示“今天”，其余 M月D日；后附时间 HH:mm
  setDate(date, time) {
    const t = time !== undefined ? time : (this.data.time || this.nowClock())
    const dateLabel = (date === util.dateStr() ? '今天' : util.md(date)) + ' ' + t
    this.setData({ date, time: t, dateLabel })
  },

  // 其它设备的改动同步到本机后由 App 调用。表单正在输入，不重置、不刷新；
  // 只在正在编辑的账单已被别处删除时提示一次，让用户别白改
  onDataChanged() {
    const id = this.data.editId
    if (id && !this._deletedWarned && !store.getBill(id)) {
      this._deletedWarned = true
      wx.showToast({ title: '这笔账单已在其他设备删除，修改无法保存', icon: 'none', duration: 2500 })
    }
  },

  onShow() {
    const cloudOn = cloud.isLoggedIn()
    if (cloudOn !== this.data.cloudOn) this.setData({ cloudOn })
    // 从「添加账户」「编辑分类」返回时刷新（首次进入由 onLoad 处理）
    if (this._shown) {
      this.initAccounts()
      this.buildGrid(this.data.curType) // 从「编辑分类」返回：分类 / 子分类可能已变
      if (!this.data.subs.includes(this.data.selectedSub)) this.setData({ selectedSub: '' })
      this.syncAccViews()
    }
    this._shown = true
  },

  goBack() { wx.navigateBack() },

  initAccounts() {
    // 债务分组账户不作为付款/收款账户
    const all = store.getAccounts(false).filter(a => kinds.groupOf(a) !== 'debt')
    const accounts = all.map(a => ({ id: a.id, name: a.name, icon: a.icon, type: a.type }))
    this.setData({ accounts })
  },

  accView(id, unset) {
    if (unset) return { name: '', icon: '', noAcc: false } // 转账 / 债务尚未选择：显示占位
    if (!id) return { name: '无账户', icon: '', noAcc: true }
    const a = store.getAccount(id)
    return a ? { name: a.name, icon: a.icon, noAcc: false } : { name: '', icon: '', noAcc: false }
  },

  syncAccViews() {
    const d = this.data
    const strict = d.curType === 'transfer' || d.curType === 'debt'
    this.setData({
      accFrom: this.accView(d.selectedAccountId, strict && !d.fromSet),
      accTo: this.accView(d.selectedToAccountId, strict && !d.toSet)
    })
    this.syncDebtView()
  },

  // 债务卡片：按已选债务同步名称 / 余额 / 图标 / 箭头方向，以及下方的操作按钮
  syncDebtView() {
    const d = this.data
    if (d.curType !== 'debt') return
    if (!d.debtPicked) {
      this.setData({ debtLabel: '', debtIcon: '', debtBalText: '', debtActions: [], debtFeeMode: false, debtDown: true })
      return
    }
    const c = cats.getCat(d.selectedId, 'debt')
    const acc = d.debtAccountId ? store.getAccount(d.debtAccountId) : null
    // 应付款（借入账户）：借入 / 还款；应收款（借出账户）：借出 / 收款。没有债务账户的旧账单按分类判断
    const kind = acc
      ? (acc.kind === 'payable' ? 'payable' : 'receivable')
      : ((d.selectedId === 'borrow' || d.selectedId === 'repay') ? 'payable' : 'receivable')
    const actions = kind === 'payable'
      ? [{ id: 'borrow', label: '借入' }, { id: 'repay', label: '还款' }]
      : [{ id: 'lend', label: '借出' }, { id: 'collect', label: '收款' }]
    this.setData({
      debtLabel: acc ? acc.name : (d.debtAccountName || (c ? c.label : '')),
      debtIcon: acc ? acc.icon : (c ? cats.iconPath(c.icon, false) : ''),
      debtBalText: acc ? '余额：' + util.money(store.accountBalance(acc.id)) : '',
      debtActions: actions,
      debtFeeMode: d.selectedId === 'repay' || d.selectedId === 'collect',
      debtDown: d.selectedId === 'borrow' || d.selectedId === 'collect'
    })
  },

  // 切换操作（借入 / 还款，借出 / 收款）
  pickDebtAction(e) {
    const id = e.currentTarget.dataset.id
    if (id === this.data.selectedId) return
    this.setData({ selectedId: id })
    this.syncDebtView()
  },

  // 生成账单勾选框
  toggleGenBill() { this.setData({ genBill: !this.data.genBill }) },


  // 编辑已有账单
  loadForEdit(id) {
    const b = store.getBill(id)
    if (!b) { wx.navigateBack(); return }
    wx.setNavigationBarTitle({ title: '编辑账单' })
    // 新增债务账户时生成的初始账单：「计入收支」由账户页单独设定（可能是有账户不计、无账户计入），编辑时保持原样，不按「生成账单」改写
    this._initialDebt = b.type === 'debt' && !!b.debtAccountId && !b.debtLink
    this._origNoCount = !!b.noCount
    const reimbAcc = b.reimburseAccountId ? store.getAccount(b.reimburseAccountId) : null
    this.setData({
      editId: id,
      curType: b.type,
      amount: util.trimZero(util.fixed(b.amount)),
      btnState: 'done',
      remark: b.remark,
      tag: b.tag,
      reimburse: !!b.reimburse,
      noCount: !!b.noCount,
      noBudget: !!b.noBudget,
      reimburseAccountId: b.reimburseAccountId || '',
      reimburseAccountName: b.reimburseAccount || '',
      reimburseAccountIcon: reimbAcc ? reimbAcc.icon : '',
      attachments: b.attachments || [],
      selectedAccountId: b.accountId === '' ? '' : (store.accIdOf(b, 'from') || this.data.accounts[0].id),
      selectedToAccountId: store.accIdOf(b, 'to') || this.data.accounts[0].id,
      fromSet: true,
      toSet: true,
      fee: store.billFee(b) > 0 ? util.trimZero(util.fixed(store.billFee(b))) : '',
      debtPicked: b.type === 'debt',
      genBill: b.type === 'debt' && !!b.accountId,
      debtAccountId: b.debtAccountId || '',
      debtAccountName: b.debtAccount || '',
      debtLink: !!b.debtLink,
      repayDate: b.repayDate || '',
      repayLabel: b.repayDate ? util.md(b.repayDate) : ''
    })
    this.setDate(b.date, b.time)
    this.buildGrid(b.type)
    this.setData({ selectedId: b.catId })
    this.showSubsFor(b.catId)
    if (b.sub) this.setData({ selectedSub: b.sub })
    this.syncAccViews()
  },

  // 用 query / 模板字段预填
  applyPrefill(o) {
    const patch = {}
    if (o.catId) patch.selectedId = o.catId
    if (o.sub) patch.selectedSub = o.sub
    if (o.amount) {
      patch.amount = util.trimZero(util.fixed(Number(o.amount)))
      patch.btnState = 'done'
    }
    if (o.remark) patch.remark = o.remark
    if (o.tag) patch.tag = o.tag
    if (o.reimburse === '1') patch.reimburse = true
    // 报销账户详情页「添加一条报销」：直接选中该报销账户
    if (o.reimburseAccountId && this.data.curType === 'expense') {
      const ra = store.getAccount(o.reimburseAccountId)
      if (ra && store.isReimburseAccount(ra.id)) {
        Object.assign(patch, { reimburse: true, reimburseAccountId: ra.id, reimburseAccountName: ra.name, reimburseAccountIcon: ra.icon })
      }
    }
    if (o.accountId) { patch.selectedAccountId = o.accountId; patch.fromSet = true; if (this.data.curType === 'debt') patch.genBill = true }
    else if (o.noAcc === '1') { patch.selectedAccountId = ''; patch.fromSet = true } // AI 记账未指定账户：保持「无账户」，不套用默认微信
    if (o.toAccountId) { patch.selectedToAccountId = o.toAccountId; patch.toSet = true }
    // 债务账户详情页的「追加借入 / 借出」「还款 / 收款」：直接选中该应付款 / 应收款账户（记在它名下，调整其余额）
    if (o.debtAccountId && this.data.curType === 'debt') {
      const da = store.getAccount(o.debtAccountId)
      if (da && kinds.groupOf(da) === 'debt' && (da.kind === 'payable' || da.kind === 'receivable')) {
        Object.assign(patch, { debtPicked: true, debtAccountId: da.id, debtAccountName: da.name, debtLink: true })
      }
    }
    // 模板 / AI 带来的借入、借出只作为方向提示；债务必须由用户在卡片里选一个债务账户
    if (Object.keys(patch).length) this.setData(patch)
    if (o.date) this.setDate(o.date)
    if (o.catId) {
      this.buildGrid(this.data.curType)
      this.setData({ selectedId: o.catId })
      this.showSubsFor(o.catId)
    }
    this.syncAccViews()
  },

  // ------------------------------------------------ 类型 & 分类
  switchType(type) {
    this.setData({
      curType: type,
      subPanel: false,
      selectedSub: '',
      reimburse: false,
      noCount: false,
      noBudget: false,
      attrSheet: false,
      reimburseAccountId: '',
      reimburseAccountName: '',
      reimburseAccountIcon: '',
      reimbSheet: false,
      combineAccounts: type === 'expense' ? this.data.combineAccounts : [],
      // 转账 / 债务专属状态：切换类型即清空，避免带到别的类型
      fee: '', feeSheet: false, feeInput: '',
      repayDate: '', repayLabel: '',
      debtPicked: false, debtAccountId: '', debtAccountName: '', debtLink: false, debtSheet: false,
      genBill: false, debtActions: [], debtFeeMode: false, debtBalText: ''
    })
    this.buildGrid(type)
    if (!this.data.editId) {
      if (type === 'transfer' || type === 'debt') {
        // 转账 / 债务：账户一律从空白开始，由用户明确选择（与设计稿「请选择…」占位一致）
        this.setData({ selectedAccountId: '', selectedToAccountId: '', fromSet: false, toSet: false })
      } else {
        // 支出 / 收入：默认记忆上次手动选择的账户
        const defAcc = store.lastAccountId(this.data.accounts) || 'a_wechat'
        this.setData({ selectedAccountId: defAcc, selectedToAccountId: 'a_mybank', fromSet: true, toSet: true })
      }
    }
    this.syncAccViews()
  },

  tapType(e) {
    if (this.data.editId) return
    this.switchType(e.currentTarget.dataset.type)
  },

  buildGrid(type) {
    const list = store.visibleCats(type)
    const tiles = list.map(c => ({
      id: c.id,
      label: c.label,
      icon: cats.iconPath(c.icon, false),
      iconOn: cats.iconPath(c.icon, true)
    }))
    // 支出 / 收入的一级分类可编辑：网格末尾追加「编辑」入口
    if (type === 'expense' || type === 'income') tiles.push({ id: EDIT_ID, label: '编辑', isEdit: true })
    let selId = this.data.selectedId
    if (!list.find(c => c.id === selId)) selId = list[0].id
    this.setData({ rows: chunk(tiles, COLS), selectedId: selId })
    // 默认展开当前一级分类的二级菜单（新建记账 / 切换类型均生效）
    this.showSubsFor(selId)
    this.syncDebtView()
  },

  tapCat(e) {
    const id = e.currentTarget.dataset.id
    if (id === EDIT_ID) {
      wx.navigateTo({ url: '/pages/cat-edit/cat-edit?' + util.toQuery({ type: this.data.curType }) })
      return
    }
    this.setData({ selectedId: id, selectedSub: '' })
    this.showSubsFor(id)
  },

  // 展开某一级分类的二级菜单：显示在该分类所在行的正下方（即使没有子项也保留面板，供「编辑」）
  showSubsFor(id) {
    const type = this.data.curType
    const subRow = this.data.rows.findIndex(row => row.some(c => c.id === id))
    this.setData({ subs: store.subsOf(type, id), subPanel: true, subRow })
  },

  // 二级面板「编辑」：进入当前一级分类的子分类编辑页
  tapEditSubs() {
    wx.navigateTo({
      url: '/pages/cat-edit/cat-edit?' + util.toQuery({ type: this.data.curType, cat: this.data.selectedId })
    })
  },

  tapSub(e) {
    const name = e.currentTarget.dataset.name
    this.setData({ selectedSub: name === this.data.selectedSub ? '' : name })
  },

  // ------------------------------------------------ 账户（单列表二级菜单：可拖动排序 + 组合支付）
  openAccSheet(e) {
    const role = e.currentTarget.dataset.role === 'to' ? 'to' : 'from'
    const strict = this.data.curType === 'transfer' || this.data.curType === 'debt'
    const isSet = role === 'to' ? this.data.toSet : this.data.fromSet
    // 转账 / 债务尚未选择时不高亮任何一行（否则「无账户」的空 id 会被误判为已选中）
    const selId = strict && !isSet ? '__unset'
      : (role === 'to' ? this.data.selectedToAccountId : this.data.selectedAccountId)
    // 组合支付仅对「支出 · 转出账户」开放，且新建（非编辑）时才允许
    const combineAllowed = role === 'from' && this.data.curType === 'expense' && !this.data.editId
    const combineIds = combineAllowed ? this.data.combineAccounts.map(a => a.id) : []
    this.setData({
      accSheet: true,
      accRole: role,
      accSelectedId: selId,
      accCombine: combineAllowed && combineIds.length >= 2,
      accCombineIds: combineIds
    })
    this.buildAccList()
    // 记录一次 rpx->px 换算，供拖动排序按行高计算
    if (!this._rowPx) {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this._rowPx = (info.windowWidth || 375) / 750 * 100 // .as-row 行高 100rpx
    }
  },

  // 是否允许在当前场景显示「无账户」（转账双端必须是真实账户）
  canShowNoAcc() {
    return this.data.accRole === 'from' && this.data.curType !== 'transfer'
  },

  buildAccList() {
    const bills = store.getBillsSync()
    const list = this.data.accounts.map(a => ({
      id: a.id, name: a.name, icon: a.icon, noAcc: false,
      balanceText: util.money(store.availableBalance(a.id, bills))
    }))
    if (this.canShowNoAcc()) {
      list.unshift({ id: '', name: '无账户', icon: '', noAcc: true, balanceText: '' })
    }
    this.setData({ accList: list })
  },

  pickAccount(e) {
    const id = e.currentTarget.dataset.id
    const d = this.data

    if (d.accCombine) {
      if (!id) return // “无账户” 不参与组合支付
      // 组合支付模式：点击切换勾选，不立即关闭弹层
      const ids = d.accCombineIds.slice()
      const i = ids.indexOf(id)
      if (i >= 0) ids.splice(i, 1); else ids.push(id)
      this.setData({ accCombineIds: ids })
      return
    }

    if (d.accRole === 'to') {
      // 选中的转入账户与转出相同时，自动对调，避免出现同账户转账
      const patch = { selectedToAccountId: id, toSet: true }
      if (d.fromSet && id === d.selectedAccountId) {
        patch.selectedAccountId = d.selectedToAccountId
        patch.fromSet = d.toSet
      }
      this.setData(patch)
    } else {
      const patch = { selectedAccountId: id, fromSet: true, combineAccounts: [] }
      // 债务：选了具体账户就意味着要在该账户生成账单；选「无账户」则只调整债务账户余额
      if (d.curType === 'debt') patch.genBill = !!id
      if (d.curType === 'transfer' && d.toSet && id === d.selectedToAccountId) {
        patch.selectedToAccountId = d.selectedAccountId
        patch.toSet = d.fromSet
      }
      this.setData(patch)
    }
    this.syncAccViews()
    this.closeAccSheet()
  },

  // 组合支付：开关
  toggleCombine() {
    if (this.data.accCombine) {
      this.setData({ accCombine: false, accCombineIds: [] })
    } else {
      this.setData({ accCombine: true, accCombineIds: this.data.selectedAccountId ? [this.data.selectedAccountId] : [] })
    }
  },

  // 组合支付：确认（至少 2 个账户）
  confirmCombine() {
    const ids = this.data.accCombineIds
    if (ids.length < 2) {
      wx.showToast({ title: '至少选择 2 个账户', icon: 'none' })
      return
    }
    const combineAccounts = ids.map(id => {
      const a = store.getAccount(id)
      return a ? { id: a.id, name: a.name, icon: a.icon } : null
    }).filter(Boolean)
    this.setData({
      combineAccounts,
      selectedAccountId: combineAccounts[0].id
    })
    this.syncAccViews()
    this.closeAccSheet()
  },

  // 提示如何拖动排序（对应顶部的排序图标）
  tapReorderHint() {
    wx.showToast({ title: '长按账户可拖动排序', icon: 'none' })
  },

  // ---- 拖动排序：长按起手，随手指上下移动逐格交换，松手写回本地顺序
  onDragStart(e) {
    if (this.data.accCombine) return // 组合支付选择时不进入拖拽
    const id = e.currentTarget.dataset.id
    if (!id) return // “无账户” 不可拖动
    this._dragY = e.touches[0].clientY
    this.setData({ accDragging: true, accDragId: id })
  },

  onDragMove(e) {
    if (!this.data.accDragging) return
    const rowPx = this._rowPx || 50
    const y = e.touches[0].clientY
    let dy = y - this._dragY
    const list = this.data.accList.slice()
    let idx = list.findIndex(a => a.id === this.data.accDragId)
    if (idx < 0) return
    const offset = this.canShowNoAcc() ? 1 : 0 // “无账户” 固定置顶，不参与交换
    while (dy > rowPx / 2 && idx < list.length - 1) {
      const tmp = list[idx]; list[idx] = list[idx + 1]; list[idx + 1] = tmp
      idx += 1; dy -= rowPx; this._dragY += rowPx
    }
    while (dy < -rowPx / 2 && idx > offset) {
      const tmp = list[idx]; list[idx] = list[idx - 1]; list[idx - 1] = tmp
      idx -= 1; dy += rowPx; this._dragY -= rowPx
    }
    this.setData({ accList: list })
  },

  onDragEnd() {
    if (!this.data.accDragging) return
    this.setData({ accDragging: false, accDragId: '' })
    const ids = this.data.accList.filter(a => !a.noAcc).map(a => a.id)
    store.reorderAccounts(ids)
    this.initAccounts()
  },

  closeAccSheet() {
    this.setData({ accSheet: false, accDragging: false, accDragId: '' })
  },

  goAddAccount() {
    this.setData({ accSheet: false })
    wx.navigateTo({ url: '/pages/account-add/account-add' })
  },

  // 标签 / 备注改为弹窗输入：避免原生键盘弹出后盖住自定义计算器键盘
  // （此前用 <input> 内联编辑时，系统键盘会覆盖底部键盘，其自带的
  // “完成”按钮还会挡在“取消”键位置，看起来像“取消”变成了“完成”）
  editTag() {
    wx.showModal({
      title: '标签',
      editable: true,
      placeholderText: '标签名称',
      content: this.data.tag || '',
      success: (res) => {
        if (res.confirm) this.setData({ tag: (res.content || '').trim() })
      }
    })
  },
  removeTag() { this.setData({ tag: '' }) },

  // 备注：点击直接在输入框内聚焦输入（不再使用弹窗）
  focusRemark() { this.setData({ remarkFocus: true }) },
  blurRemark() { this.setData({ remarkFocus: false }) },
  onRemarkInput(e) { this.setData({ remark: e.detail.value }) },

  // 报销账户：债务分组下 kind=reimburse 的账户
  reimburseAccounts() {
    return store.getAccounts(false).filter(a =>
      kinds.groupOf(a) === 'debt' && a.kind === 'reimburse')
  },

  // 点击「报销」chip：弹出报销账户选择二级菜单（不报销 + 报销账户）；
  // 付款账户（账户 chip）保持不变——报销前钱从实际付款账户支出
  openReimbSheet() {
    if (this.data.curType !== 'expense') return
    const raList = this.reimburseAccounts()
    if (!raList.length) {
      wx.showModal({
        title: '暂无报销账户',
        content: '请先新增一个报销账户',
        confirmText: '去新增', cancelText: '取消',
        success: r => {
          if (r.confirm) {
            wx.navigateTo({ url: '/pages/account-edit/account-edit?group=debt&kind=reimburse' })
          }
        }
      })
      return
    }
    const bills = store.getBillsSync()
    const reimbList = raList.map(a => ({
      id: a.id, name: a.name, icon: a.icon,
      balanceText: util.money(store.accountBalance(a.id, bills))
    }))
    this.setData({ reimbSheet: true, reimbList })
  },

  closeReimbSheet() { this.setData({ reimbSheet: false }) },

  goAddReimbAccount() {
    this.setData({ reimbSheet: false })
    wx.navigateTo({ url: '/pages/account-edit/account-edit?group=debt&kind=reimburse' })
  },

  // 选中报销账户（id 非空 → 可报销）或「不报销」（id 空）
  pickReimbOption(e) {
    const id = e.currentTarget.dataset.id
    if (!id) {
      this.setData({
        reimbSheet: false, reimburse: false,
        reimburseAccountId: '', reimburseAccountName: '', reimburseAccountIcon: ''
      })
      return
    }
    const a = store.getAccount(id)
    this.setData({
      reimbSheet: false, reimburse: true,
      reimburseAccountId: id, reimburseAccountName: a ? a.name : '', reimburseAccountIcon: a ? a.icon : ''
    })
  },

  // ------------------------------------------------ 日期时间选择底部弹层
  openDtSheet() {
    this.setData({
      dtSheet: true,
      selDate: this.data.date,
      selTime: this.data.time || this.nowClock()
    })
    const [y, m] = this.data.date.split('-').map(Number)
    this.buildCal(y, m)
  },

  // 构建某月日历格子（周一为一周起始），标记选中日与今天
  buildCal(y, m) {
    const first = new Date(y, m - 1, 1).getDay() // 0=周日
    const lead = (first + 6) % 7
    const dim = util.daysInMonth(y, m)
    const today = util.dateStr()
    const cells = []
    for (let k = 0; k < lead; k++) cells.push({ blank: true, key: 'b' + k })
    for (let d = 1; d <= dim; d++) {
      const ds = y + '-' + util.pad(m) + '-' + util.pad(d)
      cells.push({
        day: d, date: ds, key: ds,
        isSel: ds === this.data.selDate,
        isToday: ds === today
      })
    }
    this.setData({ calCells: cells, calTitle: y + '-' + util.pad(m) })
  },

  // 标题「YYYY-MM ▼」切换月份（原生 month picker）
  onPickCalMonth(e) {
    const v = e.detail.value
    if (!v) return
    const [y, m] = v.split('-').map(Number)
    this.buildCal(y, m)
  },

  // 选中某一天（不立即关闭，点「完成」才确认）
  tapCalDay(e) {
    const ds = e.currentTarget.dataset.date
    if (!ds) return // 前置空白格不可选，避免把 selDate 置空
    const calCells = this.data.calCells.map(c =>
      c.date ? Object.assign(c, { isSel: c.date === ds }) : c)
    this.setData({ selDate: ds, calCells })
  },

  // 「回今天」：切到今天所在月份并选中今天
  goCalToday() {
    const t = util.dateStr()
    const [ty, tm] = t.split('-').map(Number)
    this.setData({ selDate: t })
    this.buildCal(ty, tm)
  },

  // 时间行：原生 time picker 选择 HH:mm 后更新
  onPickTime(e) {
    const v = e.detail.value
    if (v) this.setData({ selTime: v })
  },

  cancelDt() { this.setData({ dtSheet: false }) },

  confirmDt() {
    this.setDate(this.data.selDate, this.data.selTime)
    this.setData({ dtSheet: false })
  },

  swapAccounts() {
    const d = this.data
    this.setData({
      selectedAccountId: d.selectedToAccountId,
      selectedToAccountId: d.selectedAccountId,
      fromSet: d.toSet,
      toSet: d.fromSet
    })
    this.syncAccViews()
  },

  // ------------------------------------------------ 债务选择器
  // 列表只显示债务分组里的账户：应付款 = 借入，应收款 = 借出。借入 / 借出由所选账户的类型决定，
  // 不再单独提供选项（两处都能选会让人分不清到底按哪个记）
  openDebtSheet() {
    const d = this.data
    if (d.editId && d.debtAccountId && !d.debtLink) {
      // 新增债务账户时生成的初始账单：金额已记在该债务账户的初始余额里，改债务会重复计算
      wx.showToast({ title: '这是新增账户时生成的初始账单，不能更换债务', icon: 'none' })
      return
    }
    const bills = store.getBillsSync()
    const list = []
    store.getAccounts(false)
      .filter(a => kinds.groupOf(a) === 'debt' && (a.kind === 'payable' || a.kind === 'receivable'))
      .forEach(a => {
        const pending = store.debtPending(a, store.accountBalance(a.id, bills))
        list.push({
          key: 'acc:' + a.id, catId: a.kind === 'payable' ? 'borrow' : 'lend', accountId: a.id,
          name: a.name, icon: a.icon,
          sub: (a.kind === 'payable' ? '待还 ' : '待收 ') + util.money(pending)
        })
      })
    const selKey = d.debtAccountId ? 'acc:' + d.debtAccountId : ''
    this.setData({ debtSheet: true, debtList: list, debtSelKey: selKey })
  },

  closeDebtSheet() { this.setData({ debtSheet: false }) },

  pickDebt(e) {
    const item = this.data.debtList.find(x => x.key === e.currentTarget.dataset.key)
    if (!item) return
    // 同类型账户之间切换时保留已选的操作（例如已选「还款」，换另一个应付款账户仍是还款）
    const sameKind = (item.catId === 'borrow') === (this.data.selectedId === 'borrow' || this.data.selectedId === 'repay')
    const keep = this.data.debtPicked && sameKind && ['borrow', 'repay', 'lend', 'collect'].indexOf(this.data.selectedId) >= 0
    this.setData({
      selectedId: keep ? this.data.selectedId : item.catId,
      debtPicked: true,
      debtAccountId: item.accountId,
      debtAccountName: item.accountId ? item.name : '',
      debtLink: !!item.accountId,
      debtSheet: false
    })
    this.syncDebtView()
  },

  goAddDebtAccount() {
    this.setData({ debtSheet: false })
    wx.navigateTo({ url: '/pages/account-add/account-add' })
  },

  // ------------------------------------------------ 还款日期（债务）
  onRepayDate(e) {
    const v = e.detail.value
    if (!v) return
    this.setData({ repayDate: v, repayLabel: util.md(v) })
  },
  clearRepay() { this.setData({ repayDate: '', repayLabel: '' }) },

  // ------------------------------------------------ 手续费（转账）
  openFeeSheet() { this.setData({ feeSheet: true, feeInput: this.data.fee }) },
  closeFeeSheet() { this.setData({ feeSheet: false }) },

  // 只保留数字和一个小数点，小数最多 2 位（返回值会回写到输入框）
  onFeeInput(e) {
    let v = String(e.detail.value || '').replace(/[^\d.]/g, '')
    const i = v.indexOf('.')
    if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '').slice(0, 2)
    this.setData({ feeInput: v })
    return v
  },

  clearFee() { this.setData({ fee: '', feeInput: '', feeSheet: false }) },

  confirmFee() {
    const raw = this.data.feeInput
    const v = Number(raw)
    if (raw !== '' && !isFinite(v)) { wx.showToast({ title: '手续费金额无效', icon: 'none' }); return }
    const patch = { fee: v > 0 ? util.trimZero(util.fixed(v)) : '', feeSheet: false }
    if (v > 0 && this.data.curType === 'debt') patch.genBill = true // 手续费要从资金账户扣，必须生成账单
    this.setData(patch)
  },

  // ------------------------------------------------ 键盘
  // 根据金额字符串判断右下键状态：'0'→取消，含运算符→=，纯数字→完成
  btnStateOf(v) {
    if (v === '0') return 'cancel'
    if (/[+\-×÷]/.test(v)) return 'equal'
    return 'done'
  },

  tapKey(e) {
    const k = e.currentTarget.dataset.k
    const OPS = '+-×÷'
    let v = this.data.amount
    if (k === 'del') {
      v = v.length > 1 ? v.slice(0, -1) : '0'
    } else if (OPS.indexOf(k) >= 0) {
      if (v === '0') return
      const last = v.slice(-1)
      if (OPS.indexOf(last) >= 0) {
        // 末尾已是运算符：替换为新运算符
        v = v.slice(0, -1) + k
      } else {
        // 自动对当前表达式求值，结果后追加新运算符
        const r = util.calcExpr(v)
        v = isFinite(r) ? util.trimZero(util.fixed(r)) + k : v + k
      }
    } else if (k === '.') {
      const seg = v.split(/[+\-×÷]/).pop()
      if (seg.indexOf('.') < 0) v += seg === '' ? '0.' : '.'
    } else {
      const seg = v.split(/[+\-×÷]/).pop()
      if (seg.indexOf('.') >= 0 && seg.split('.')[1].length >= 2) return
      v = v === '0' ? k : v + k
    }
    this.setData({ amount: v, btnState: this.btnStateOf(v) })
  },

  // 右下键三态分发：取消→回首页；=→求值后变完成；完成→保存并返回
  tapBottomRight() {
    const state = this.data.btnState
    if (state === 'cancel') {
      wx.switchTab({ url: '/pages/index/index' })
    } else if (state === 'equal') {
      const r = util.calcExpr(this.data.amount)
      if (!isFinite(r)) { wx.showToast({ title: '表达式无效', icon: 'none' }); return }
      const v = util.trimZero(util.fixed(r))
      this.setData({ amount: v, btnState: 'done' })
    } else {
      this.finishAndBack()
    }
  },

  // 保存并返回上一页
  finishAndBack() {
    const n = this.trySave()
    if (!n) return
    wx.showToast({ title: n > 1 ? ('已记账 ' + n + ' 笔') : '已记账', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 450)
  },

  // ------------------------------------------------ 保存
  // 解析「从」账户：空字符串代表用户主动选择的“无账户”，与账户缺失/未选中区分开
  accountFor(id) {
    if (!id) return { id: '', name: '无账户' }
    return store.getAccount(id) || this.data.accounts[0]
  },

  collect() {
    const d = this.data
    // 债务未勾选「生成账单」：不动资金账户，只调整债务账户余额（相当于无账户）
    const noFund = d.curType === 'debt' && !d.genBill
    const acc = noFund ? { id: '', name: '' } : this.accountFor(d.selectedAccountId)
    const toAcc = store.getAccount(d.selectedToAccountId) || d.accounts[0]
    const feeOn = d.curType === 'transfer' || (d.curType === 'debt' && d.genBill && d.debtFeeMode)
    return {
      type: d.curType,
      catId: d.selectedId,
      sub: d.selectedSub,
      amount: util.calcExpr(d.amount),
      date: d.date,
      time: d.time,
      accountId: acc.id, account: acc.name,
      toAccountId: toAcc.id, toAccount: toAcc.name,
      remark: d.remark.trim(),
      tag: d.tag,
      reimburse: d.curType === 'expense' ? d.reimburse : false,
      reimburseAccountId: d.curType === 'expense' && d.reimburse ? d.reimburseAccountId : '',
      reimburseAccount: d.curType === 'expense' && d.reimburse ? d.reimburseAccountName : '',
      attachments: d.attachments,
      // 账单属性：收入只有「不计入收支」；转账没有这两项。
      // 债务：「生成账单」决定是否计入收支——勾选 = 计入（统计页的借入 / 借出 / 还款 / 收款），不勾选 = 不计入，只调整债务账户余额
      noCount: d.curType === 'debt'
        ? (d.editId && this._initialDebt ? !!this._origNoCount : !d.genBill)
        : (d.curType === 'expense' || d.curType === 'income') ? !!d.noCount : false,
      noBudget: d.curType === 'expense' ? !!d.noBudget : false,
      // 转账手续费（由转出账户另付）
      fee: feeOn ? (Number(d.fee) > 0 ? Math.round(Number(d.fee) * 100) / 100 : 0) : 0,
      // 债务：具体债务账户 + 还款 / 收款日期（还款、收款操作没有日期，换成手续费）
      debtAccountId: d.curType === 'debt' ? d.debtAccountId : '',
      debtAccount: d.curType === 'debt' ? d.debtAccountName : '',
      debtLink: d.curType === 'debt' && !!d.debtAccountId && !!d.debtLink,
      repayDate: d.curType === 'debt' && !d.debtFeeMode ? d.repayDate : ''
    }
  },

  // 校验金额并落盘；失败弹出提示并返回 0，成功返回创建/更新的笔数
  trySave() {
    const d = this.data
    const total = util.calcExpr(d.amount)
    if (!isFinite(total)) { wx.showToast({ title: '表达式无效', icon: 'none' }); return 0 }
    if (!(total > 0)) { wx.showToast({ title: '请输入金额', icon: 'none' }); return 0 }

    // 组合支付：金额按选中账户均分，分别各记一笔（仅新建 · 支出）
    if (d.curType === 'expense' && !d.editId && d.combineAccounts.length >= 2) {
      const shares = util.splitAmount(total, d.combineAccounts.length)
      const base = {
        type: 'expense', catId: d.selectedId, sub: d.selectedSub, date: d.date, time: d.time,
        remark: d.remark.trim(), tag: d.tag, reimburse: d.reimburse, attachments: d.attachments,
        noCount: !!d.noCount, noBudget: !!d.noBudget
      }
      d.combineAccounts.forEach((a, i) => {
        store.addBill(Object.assign({}, base, { amount: shares[i], accountId: a.id, account: a.name }))
      })
      return d.combineAccounts.length
    }

    // 转账 / 债务：必须先在卡片里选好账户 / 债务
    if (d.curType === 'transfer') {
      if (!d.fromSet) { wx.showToast({ title: '请选择转出账户', icon: 'none' }); return 0 }
      if (!d.toSet) { wx.showToast({ title: '请选择转入账户', icon: 'none' }); return 0 }
    }
    if (d.curType === 'debt') {
      if (!d.debtPicked) { wx.showToast({ title: '请选择债务', icon: 'none' }); return 0 }
      // 勾选「生成账单」才需要资金账户；不勾选只调整债务账户余额，账户可以留空
      if (d.genBill && (!d.fromSet || !d.selectedAccountId)) { wx.showToast({ title: '请选择账户', icon: 'none' }); return 0 }
      if (!d.debtFeeMode && d.repayDate && d.repayDate < d.date) {
        wx.showToast({ title: (d.selectedId === 'lend' ? '收款' : '还款') + '日期不能早于记账日期', icon: 'none' }); return 0
      }
    }

    const data = this.collect()
    if (data.type === 'transfer' && data.accountId === data.toAccountId) {
      wx.showToast({ title: '转出转入不能相同', icon: 'none' })
      return 0
    }
    if (d.editId) {
      // 找不到 = 这笔账单已被另一台设备删除：不能假装保存成功（修改会悄悄丢掉），留在页面上提示
      if (!store.updateBill(d.editId, data)) {
        wx.showToast({ title: '该账单已在其他设备删除，无法保存修改', icon: 'none' })
        return 0
      }
    } else {
      store.addBill(data)
      // 记忆上次手动选择的收支账户，下次记账默认显示
      if (data.accountId) store.setLastAccountId(data.accountId)
    }
    return 1
  },

  // 键盘左下角「再记」：保存（新建或修改）后不离开页面，重置输入区以便连续记账
  tapAgain() {
    const n = this.trySave()
    if (!n) return
    if (this.data.editId) {
      // 编辑态：先保存修改，再转为新建态继续再记
      this.setData({ editId: '' })
      wx.showToast({ title: '已保存', icon: 'success' })
      this.resetForNext()
      return
    }
    wx.showToast({ title: n > 1 ? ('已记账 ' + n + ' 笔') : '已记账', icon: 'success' })
    this.resetForNext()
  },

  // 记完一笔后重置输入区，保留类型/分类/账户/日期，方便连续记录同类账单
  resetForNext() {
    this.setData({
      amount: '0', btnState: 'cancel', remark: '', tag: '',
      reimburse: false, reimburseAccountId: '', reimburseAccountName: '', reimburseAccountIcon: '',
      noCount: false, noBudget: false,
      fee: '', repayDate: '', repayLabel: '',
      attachments: [], combineAccounts: []
    })
    this.syncDebtView()
  },

  // 长按「再记」＝存为模板（原“存模板”按钮的位置让给了新键盘布局）
  longPressAgain() {
    if (this.data.editId) return
    this.saveTemplate()
  },

  // 存为模板
  saveTemplate() {
    const data = this.collect()
    if (!data.amount && !data.remark) {
      wx.showToast({ title: '先填写金额或备注', icon: 'none' }); return
    }
    wx.showModal({
      title: '存为模板',
      editable: true,
      placeholderText: '模板名称，如：每月房租',
      success: (res) => {
        if (res.confirm) {
          store.addTemplate(Object.assign({}, data, { name: res.content || '常用模板' }))
          wx.showToast({ title: '模板已保存', icon: 'success' })
        }
      }
    })
  },

  // ------------------------------------------------ 属性（账单设置）
  // 弹层里改的是暂存值：点「完成」才写回，点 × / 遮罩放弃
  openAttrSheet() {
    const d = this.data
    this.setData({ attrSheet: true, attrCount: d.noCount, attrBudget: d.noBudget })
  },

  closeAttrSheet() { this.setData({ attrSheet: false }) },

  toggleAttr(e) {
    const k = e.currentTarget.dataset.k
    this.setData({ [k]: !this.data[k] })
  },

  confirmAttr() {
    const d = this.data
    this.setData({
      noCount: d.attrCount,
      noBudget: d.curType === 'expense' ? d.attrBudget : false,
      attrSheet: false
    })
  },

  // ------------------------------------------------ 附件（图片 / 文件）
  // 点「附件」chip：打开附件二级菜单（已添加的附件在菜单里管理）
  tapAttach() { this.setData({ attachSheet: true }) },

  closeAttachSheet() { this.setData({ attachSheet: false }) },

  // 菜单里的「＋」：选择添加方式
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
      // 兼容不支持 chooseMedia 的旧基础库
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

  // 存入小程序本地永久目录，避免临时文件被系统回收后失效
  saveAttachment(tempPath, type, name) {
    const push = (path) => {
      const list = this.data.attachments.concat([{
        id: util.genId(), type, path, name: name || (type === 'image' ? '图片' : '文件')
      }])
      this.setData({ attachments: list })
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
    const item = this.data.attachments.find(a => a.id === id)
    this.setData({ attachments: this.data.attachments.filter(a => a.id !== id) })
    if (item && wx.removeSavedFile) wx.removeSavedFile({ filePath: item.path, fail: () => {} })
  }
})
