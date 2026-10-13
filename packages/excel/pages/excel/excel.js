// packages/excel/pages/excel/excel.js 账单 Excel 导入 / 导出（分包页面：Excel 库只在进入本页时才加载）
// 入口：我的 → 数据管理 → 导入 / 导出 → Excel 导入 / 导出（本页：导出入口列表 + 导入；导出在 pages/export）
const util = require('../../../../utils/util')
const store = require('../../../../utils/store')
const ai = require('../../../../utils/ai')
const eb = require('../../excelBills')
const KINDS = require('../../exportKinds')

const MAX_FILE = 10 * 1024 * 1024 // 选取的文件最大字节数
const PREVIEW_ROWS = 100          // 预览最多列出多少笔（全部笔数照常导入）
const SKIP_ROWS = 8               // 「跳过」原因最多列出多少条

Page({
  data: {
    exports: KINDS,
    phase: 'idle', // idle 选文件 | working 处理中 | preview 预览确认 | done 导入完成
    working: '',
    fileName: '',
    sum: null,     // 预览汇总
    rows: [],      // 预览列表
    skips: [],
    result: null   // { added, existed }
  },

  // 精准导出先去搜索页手选账单（搜索页在主包），其余直接进导出页
  goExport(e) {
    const kind = e.currentTarget.dataset.kind
    wx.navigateTo({
      url: kind === 'picked' ? '/pages/search/search?mode=export' : '/packages/excel/pages/export/export?kind=' + kind
    })
  },

  // ------------------------------------------------ 导入：选文件 → 解析 → 分类 → 预览
  chooseFile() {
    if (!wx.chooseMessageFile) { wx.showToast({ title: '当前微信版本不支持选取文件', icon: 'none' }); return }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx', 'xls'],
      success: res => this.load(res.tempFiles[0])
    })
  },

  load(file) {
    if (file.size > MAX_FILE) { wx.showToast({ title: '文件超过 10MB', icon: 'none' }); return }
    this.setData({ phase: 'working', working: '读取表格…', fileName: file.name })
    wx.getFileSystemManager().readFile({
      filePath: file.path,
      success: r => {
        let parsed
        try { parsed = eb.parseWorkbook(r.data) } catch (e) { this.fail(e.message || '无法读取该文件'); return }
        if (!parsed.records.length) { this.fail('没有可导入的流水' + (parsed.skipped.length ? '（' + parsed.skipped.length + ' 行被跳过）' : '')); return }
        this.classify(parsed)
      },
      fail: () => this.fail('无法读取该文件')
    })
  },

  fail(msg) {
    this.setData({ phase: 'idle' })
    wx.showModal({ title: '导入失败', content: msg, showCancel: false })
  },

  classify(parsed) {
    const total = parsed.records.length
    this.setData({ working: '正在分类 ' + total + ' 笔…' })
    ai.classifyRecords(parsed.records, {
      trustCats: parsed.info.hasCat && parsed.info.hasSub,
      onProgress: (done, all) => this.setData({ working: '分类中... ' + done + ' / ' + all })
    }).then(stats => this.buildPreview(parsed, stats))
  },

  buildPreview(parsed, stats) {
    const built = eb.recordsToBills(parsed.records, {
      matchAccount: ai.accountMatcher(),
      accountName: id => (store.getAccount(id) || {}).name || ''
    })
    this._bills = built.items.map(x => x.bill)
    const skipped = parsed.skipped.concat(built.skipped).sort((a, b) => a.row - b.row)
    const label = b => {
      const c = store.getCat(b.catId, b.type)
      return (c ? c.label : '') + (b.sub ? ' › ' + b.sub : '')
    }
    const rows = built.items.slice(0, PREVIEW_ROWS).map(({ bill: b, rec }) => ({
      key: b.id,
      date: b.date.slice(5),
      name: b.remark || label(b),
      cat: label(b),
      weak: !!rec.weak,
      acc: b.type === 'transfer' ? b.account + ' → ' + b.toAccount : (b.account || '无账户'), // 收支账户；转账显示 转出 → 转入
      amt: (b.type === 'income' ? '+' : b.type === 'expense' ? '-' : '') + util.money(b.amount),
      cls: b.type === 'income' ? 'amt-green' : b.type === 'expense' ? 'amt-red' : ''
    }))
    const notes = []
    if (stats.needLogin) notes.push('未登录，使用本地规则分类')
    else if (stats.aiUnavailable) notes.push('未连接云服务，已全部使用本地规则分类')
    else if (stats.aiFailed) notes.push('有 ' + stats.aiFailed + ' 个云端分类请求失败，对应流水改用本地规则分类')
    if (stats.capped) notes.push('不同的交易文字太多，其中 ' + stats.capped + ' 笔直接用本地规则分类')
    if (parsed.info.assumedExpense) notes.push('表里没有收/支列，金额都是正数，已全部按支出处理')
    if (built.noAccount) notes.push(built.noAccount + ' 笔的账户没能对上你的账户，记为「无账户」')
    if (stats.weak) notes.push(stats.weak + ' 笔没有判断出明确分类，暂归「其他」（橙色标出），导入后可在账单详情里改')
    this.setData({
      phase: 'preview',
      sum: {
        count: built.items.length,
        skipCount: skipped.length,
        exact: stats.exact,
        cloud: stats.cloud,
        local: stats.local,
        notes
      },
      rows,
      more: Math.max(0, built.items.length - rows.length),
      skips: skipped.slice(0, SKIP_ROWS).map(s => '第 ' + s.row + ' 行：' + s.reason),
      skipMore: Math.max(0, skipped.length - SKIP_ROWS)
    })
  },

  // ------------------------------------------------ 导入：确认入账
  confirmImport() {
    if (!this._bills || !this._bills.length) return
    const r = store.mergeBills(this._bills)
    const result = { added: r.added, existed: this._bills.length - r.added }
    this._bills = null
    this.setData({ phase: 'done', result })
  },

  restart() {
    this._bills = null
    this.setData({ phase: 'idle', sum: null, rows: [], skips: [], result: null })
  },

  goBack() { wx.navigateBack() }
})
