// packages/excel/pages/export/export.js 账单导出：时间范围 / 账本 / 文件格式 → 生成 .xlsx，或连附件原图一起打包的 .zip
// 入口：我的 → 数据管理 → 导入 / 导出 → Excel 导入 / 导出 → 导出列表；?kind= 决定导出什么，见 exportKinds.js
//   精准导出（kind=picked）没有时间范围：账单 id 由搜索页经 globalData.exportIds 交过来
const util = require('../../../../utils/util')
const store = require('../../../../utils/store')
const cloud = require('../../../../utils/cloud')
const dep = require('../../../../utils/deposit')
const eb = require('../../excelBills')
const zip = require('../../zip')
const KINDS = require('../../exportKinds')

const RANGES = [
  { id: 'all', label: '全部' },
  { id: 'month', label: '本月' },
  { id: 'last', label: '上月' },
  { id: 'year', label: '今年' }
]
const FORMATS = [
  { id: 'xlsx', label: 'Excel' },
  { id: 'zip', label: 'Zip（含附件）' }
]
const ATT_BATCH = 5 // 同时读取 / 下载的附件数

const ymText = ym => ym.slice(0, 4) + '年' + Number(ym.slice(5)) + '月'

// 范围 → 起止日期（含）与展示文字。日期是 'YYYY-MM-DD' 字符串，直接按字典序比较（月末统一写 31 不影响结果）
function bounds(range, cStart, cEnd) {
  const now = new Date()
  const y = now.getFullYear()
  if (range === 'month' || range === 'last') {
    const d = new Date(y, now.getMonth() - (range === 'last' ? 1 : 0), 1)
    const ym = util.monthKey(d.getFullYear(), d.getMonth() + 1)
    return { start: ym + '-01', end: ym + '-31', text: ymText(ym) }
  }
  if (range === 'year') return { start: y + '-01-01', end: y + '-12-31', text: y + '年' }
  if (range === 'custom') return { start: cStart, end: cEnd, text: cStart + ' ~ ' + cEnd }
  return { start: '', end: '9999-12-31', text: '全部时间' }
}

// 当前选项下要导出的记录（账单或定存）+ 范围文字。kind 与账单 type 同名（transfer / debt），bill = 全部账单
function select(d, picked) {
  if (d.kind === 'picked') return { text: '手动选择', items: store.getBillsSync().filter(b => picked[b.id]) }
  const b = bounds(d.range, d.cStart, d.cEnd)
  const deposit = d.kind === 'deposit'
  const dateOf = x => deposit ? x.startDate : x.date
  const all = deposit ? store.getDeposits() : store.getBillsSync().filter(x => d.kind === 'bill' || x.type === d.kind)
  return { text: b.text, items: all.filter(x => dateOf(x) >= b.start && dateOf(x) <= b.end) }
}

// 按入口生成对应的表格
function buildSheet(kind, items) {
  const today = util.dateStr()
  if (kind === 'deposit') {
    return eb.depositBuffer(items, {
      term: d => dep.termText(d.term, d.unit),
      status: d => d.withdrawn ? '已提前支取' : store.isDepositActive(d, today) ? '在存' : '已到期'
    })
  }
  if (kind === 'debt') {
    const accounts = []
    ;[['payable', '应付款'], ['receivable', '应收款']].forEach(([k, label]) => {
      store.getDebtViews(k).forEach(v => accounts.push({ name: v.name, kind: label, pending: v.pending }))
    })
    return eb.debtBuffer(items, {
      fee: store.billFee,
      accounts,
      debtName: b => (store.getAccount(b.debtAccountId) || {}).name || ''
    })
  }
  return eb.exportBuffer(items, {
    catLabel: b => (store.getCat(b.catId, b.type) || {}).label,
    fee: store.billFee,
    sheet: kind === 'transfer' ? '转账还款' : '账单'
  })
}

// 读附件原文件：本机文件优先，没有（或已失效）就从云端下载
function readAttachment(att) {
  const fs = wx.getFileSystemManager()
  const read = filePath => new Promise((resolve, reject) => fs.readFile({ filePath, success: r => resolve(r.data), fail: reject }))
  return (att.path ? read(att.path) : Promise.reject(new Error('no-local-file')))
    .catch(() => cloud.downloadAttachment(att).then(read))
}

Page({
  data: {
    kind: 'bill',    // bill | transfer | debt | deposit | picked
    book: '',        // 账本名（概览标题 / 账本行），随 kind 取自 exportKinds.js
    ranges: RANGES,
    formats: FORMATS,
    range: 'all',    // all | month | last | year | custom
    cStart: '',
    cEnd: '',
    customOpen: false,
    fmt: 'xlsx',     // xlsx | zip
    count: 0,
    rangeText: '全部时间',
    exporting: false,
    result: null     // { name, path, openable }：生成好的文件；改任何选项都会作废
  },

  onLoad(options) {
    const kind = KINDS.some(k => k.kind === options.kind) ? options.kind : 'bill'
    this._picked = {}
    if (kind === 'picked') {
      const app = getApp()
      ;(app.globalData.exportIds || []).forEach(id => { this._picked[id] = true })
      app.globalData.exportIds = null
    }
    wx.setNavigationBarTitle({ title: KINDS.find(k => k.kind === kind).title })
    this.setData({ kind, book: KINDS.find(k => k.kind === kind).book })
  },

  onShow() { this.update({}) },

  // 选项变了：重算笔数与范围文字，并作废上一次生成的文件
  update(patch) {
    const s = select(Object.assign({}, this.data, patch), this._picked)
    this.setData(Object.assign(patch, { result: null, count: s.items.length, rangeText: s.text }))
  },

  pickRange(e) { this.update({ range: e.currentTarget.dataset.id, customOpen: false }) },

  toggleCustom() { this.setData({ customOpen: !this.data.customOpen }) },

  // 起止日期互相保证先后顺序；只选了一个时另一个先取同一天
  pickStart(e) {
    const v = e.detail.value
    this.update({ range: 'custom', cStart: v, cEnd: this.data.cEnd >= v ? this.data.cEnd : v })
  },

  pickEnd(e) {
    const v = e.detail.value
    this.update({ range: 'custom', cEnd: v, cStart: this.data.cStart && this.data.cStart <= v ? this.data.cStart : v })
  },

  pickFmt(e) { this.update({ fmt: e.currentTarget.dataset.id }) },

  // ------------------------------------------------ 导出
  doExport() {
    if (this.data.exporting) return
    const kind = this.data.kind
    const items = select(this.data, this._picked).items
    if (!items.length) { wx.showToast({ title: '没有可导出的数据', icon: 'none' }); return }
    const zipMode = this.data.fmt === 'zip' && kind !== 'deposit' // 定存没有附件，导出页也不显示格式选项
    const stem = '日常账本_' + KINDS.find(k => k.kind === kind).file + '_' + util.dateStr().replace(/-/g, '')
    const name = stem + (zipMode ? '.zip' : '.xlsx')
    const path = wx.env.USER_DATA_PATH + '/' + name
    this.setData({ exporting: true })
    Promise.resolve()
      .then(() => buildSheet(kind, items))
      .then(sheet => zipMode ? this.withAttachments(items, stem + '.xlsx', sheet) : { data: sheet, missing: 0 })
      .then(({ data, missing }) => new Promise((resolve, reject) => {
        wx.getFileSystemManager().writeFile({ filePath: path, data, success: () => resolve(missing), fail: reject })
      }))
      .then(missing => {
        this.setData({ exporting: false, result: { name, path, openable: !zipMode } })
        if (missing) wx.showToast({ title: missing + ' 个附件未能读取', icon: 'none' })
      })
      .catch(() => {
        this.setData({ exporting: false })
        wx.showToast({ title: '导出失败', icon: 'none' })
      })
  },

  // 账单表格 + 附件原文件（附件/账单ID_序号.扩展名）打成一个 zip；读不到的附件计入 missing
  withAttachments(bills, sheetName, sheet) {
    const jobs = []
    bills.forEach(b => (b.attachments || []).forEach((att, i) => {
      jobs.push({ att, name: '附件/' + b.id + '_' + (i + 1) + '.' + cloud.extOf(att) })
    }))
    const files = [{ name: sheetName, data: sheet }]
    let missing = 0
    const batches = []
    for (let i = 0; i < jobs.length; i += ATT_BATCH) batches.push(jobs.slice(i, i + ATT_BATCH))
    return batches.reduce((p, batch) => p.then(() => Promise.all(batch.map(j =>
      readAttachment(j.att).then(data => { files.push({ name: j.name, data }) }, () => { missing++ })
    ))), Promise.resolve()).then(() => ({ data: zip.zipBuffer(files), missing }))
  },

  // 必须在点击事件里直接调用（异步之后再调会失去用户手势）
  shareFile() {
    const { name, path } = this.data.result
    wx.shareFileMessage({
      filePath: path,
      fileName: name,
      fail: e => { if (!/cancel/.test(e.errMsg)) wx.showToast({ title: '无法发送', icon: 'none' }) }
    })
  },

  openFile() {
    wx.openDocument({
      filePath: this.data.result.path,
      fileType: 'xlsx',
      showMenu: true,
      fail: () => wx.showToast({ title: '无法打开', icon: 'none' })
    })
  }
})
