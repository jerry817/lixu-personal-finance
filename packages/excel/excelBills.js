// packages/excel/excelBills.js
// Excel（.xlsx / .xls）账单 ⇄ 账单对象。纯函数：不碰 wx / store，账户匹配等需要小程序数据的部分由调用方传入，
// 所以可以直接在 node 里测试。表格读写用 SheetJS（lib/xlsx.core.min.js，xlsx 与 xls 都能读，写出 xlsx）。
const XLSX = require('./lib/xlsx.core.min.js')

const MAX_RECORDS = 2000 // 单次最多导入多少笔

const TYPE_LABEL = { expense: '支出', income: '收入', transfer: '转账', debt: '债务' }

// 导出表头；导入认得这套表头（导出再导入是无损往返；「手续费」导入时忽略）
const EXPORT_HEAD = ['日期', '时间', '类型', '一级分类', '子分类', '金额', '账户', '转入账户', '标签', '备注', '报销', '手续费', '账单ID']
const EXPORT_COLS = [12, 8, 8, 12, 12, 10, 14, 14, 10, 24, 6, 8, 22]

const DEBT_HEAD = ['日期', '时间', '类型', '债务账户', '金额', '资金账户', '手续费', '还款 / 收款日', '计入收支', '备注', '账单ID']
const DEBT_COLS = [12, 8, 8, 14, 10, 14, 8, 14, 8, 24, 22]
const DEBT_LABEL = { borrow: '借入', lend: '借出', repay: '还款', collect: '收款' }

const DEPOSIT_HEAD = ['存入日期', '到期日期', '存入账户', '本金', '年利率(%)', '存期', '预计收益', '状态', '提前支取日', '提前支取收益', '备注']
const DEPOSIT_COLS = [12, 12, 14, 12, 10, 8, 12, 12, 12, 14, 24]

// ------------------------------------------------------------------ 导出
const accName = n => (n && n !== '无账户' ? n : '') // 无账户导出成空单元格
const money = v => Number(v) || 0
const byTime = (a, b) =>
  (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')) || (a.createTime || 0) - (b.createTime || 0)

// sheets: [{ name, head, cols, rows, moneyCols }] → xlsx 的 ArrayBuffer；金额列统一两位小数
function workbookBuffer(sheets) {
  const wb = XLSX.utils.book_new()
  sheets.forEach(s => {
    const ws = XLSX.utils.aoa_to_sheet([s.head].concat(s.rows))
    ws['!cols'] = s.cols.map(wch => ({ wch }))
    s.moneyCols.forEach(c => {
      for (let r = 1; r <= s.rows.length; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })]
        if (cell && typeof cell.v === 'number') cell.z = '0.00'
      }
    })
    XLSX.utils.book_append_sheet(wb, ws, s.name)
  })
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) // ArrayBuffer
}

// 账单（账单导出 / 转账还款导出 / 精准导出）
// opts: catLabel(bill) → 一级分类名；fee(bill) → 手续费；sheet 工作表名
function exportBuffer(bills, opts) {
  const rows = bills.slice().sort(byTime).map(b => [
    b.date, b.time || '', TYPE_LABEL[b.type] || b.type, opts.catLabel(b) || '', b.sub || '',
    money(b.amount), accName(b.account), b.type === 'transfer' ? accName(b.toAccount) : '',
    b.tag || '', b.remark || '', b.type === 'expense' && b.reimburse ? '是' : '', opts.fee(b) || '', b.id
  ])
  return workbookBuffer([{ name: opts.sheet, head: EXPORT_HEAD, cols: EXPORT_COLS, rows, moneyCols: [5, 11] }])
}

// 债务账单 + 债务账户当前待还 / 待收
// opts: fee(bill) → 手续费；debtName(bill) → 债务账户名；accounts: [{ name, kind, pending }]
function debtBuffer(bills, opts) {
  const rows = bills.slice().sort(byTime).map(b => [
    b.date, b.time || '', DEBT_LABEL[b.catId] || b.catId, opts.debtName(b), money(b.amount),
    accName(b.account), opts.fee(b) || '', b.repayDate || '', b.noCount ? '否' : '是', b.remark || '', b.id
  ])
  const accRows = opts.accounts.map(a => [a.name, a.kind, a.pending])
  return workbookBuffer([
    { name: '债务账单', head: DEBT_HEAD, cols: DEBT_COLS, rows, moneyCols: [4, 6] },
    { name: '债务账户', head: ['债务账户', '类型', '待还 / 待收'], cols: [16, 10, 14], rows: accRows, moneyCols: [2] }
  ])
}

// 定期存款；opts: status(d) → 在存 / 已到期 / 已提前支取；term(d) → 存期文案
function depositBuffer(deposits, opts) {
  const rows = deposits.slice().sort((a, b) => a.startDate.localeCompare(b.startDate)).map(d => [
    d.startDate, d.maturityDate || '', accName(d.account), money(d.amount), money(d.rate), opts.term(d),
    money(d.income), opts.status(d), d.withdrawDate || '', d.withdrawn ? money(d.withdrawInterest) : '', d.remark || ''
  ])
  return workbookBuffer([{ name: '定期存款', head: DEPOSIT_HEAD, cols: DEPOSIT_COLS, rows, moneyCols: [3, 6, 9] }])
}

// ------------------------------------------------------------------ 导入：认表头
// 表头别名（比较前统一：去空格 / 星号 / 括号里的单位，转小写）
const ALIAS = {
  date: ['日期', '交易日期', '记账日期', '账单日期', '交易时间', '记账时间', '发生日期', 'date'],
  time: ['时间', '时刻'],
  amount: ['金额', '交易金额', '收支金额', '发生额', 'amount'],
  expense: ['支出', '支出金额', '借方', '借方发生额', '付款金额'],
  income: ['收入', '收入金额', '贷方', '贷方发生额', '收款金额'],
  dir: ['收支', '收/支', '收支类型', '收支方向', '类型', '账单类型'],
  cat: ['分类', '类别', '一级分类', '账单分类', '消费类型', '交易分类', 'category'],
  sub: ['子分类', '二级分类', '小类'],
  counter: ['交易对方', '对方', '对方户名', '商户', '商户名称', '收款方', '付款方', '对手方'],
  product: ['商品', '商品说明', '商品名称', '交易说明', '摘要', '交易摘要', '用途', '说明', '项目'],
  kind: ['交易类型'],
  remark: ['备注', '附言', '备注信息', 'remark', 'memo'],
  account: ['账户', '支付方式', '付款方式', '收/付款方式', '支付账户', '资金账户', '账户名称'],
  toAccount: ['转入账户', '转入'],
  tag: ['标签'],
  reimburse: ['报销', '是否报销'],
  id: ['账单id'],
  ref: ['交易单号', '订单号', '流水号', '交易号', '商户单号'],
  status: ['交易状态', '状态', '当前状态']
}

function normHead(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[\s*＊]/g, '').replace(/[（(][^）)]*[）)]/g, '')
}

function fieldOf(head) {
  const h = normHead(head)
  if (!h) return ''
  return Object.keys(ALIAS).find(k => ALIAS[k].indexOf(h) >= 0) || ''
}

// 前 30 行里找表头行：要有日期，且有金额（或 收入 / 支出 两列）。微信 / 银行流水开头常有几行说明
function findHeader(aoa) {
  for (let i = 0; i < Math.min(aoa.length, 30); i++) {
    const map = {}
    ;(aoa[i] || []).forEach((cell, c) => {
      const f = fieldOf(cell)
      if (f && map[f] === undefined) map[f] = c
    })
    // 只有「时间」一列且没有「日期」：它就是日期（带时分秒的时间戳）
    if (map.date === undefined && map.time !== undefined) { map.date = map.time; delete map.time }
    if (map.date !== undefined && (map.amount !== undefined || map.expense !== undefined || map.income !== undefined)) {
      return { row: i, map }
    }
  }
  return null
}

// ------------------------------------------------------------------ 导入：单元格解析
const pad2 = n => (n < 10 ? '0' : '') + n

function validYmd(y, m, d) {
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

// → { date: 'YYYY-MM-DD', time: 'HH:mm' | '' } | null。支持 Excel 序列号、20261005、2026-10-05 / 2026/10/5 / 2026年10月5日（可带时间）
function parseDateCell(v, date1904) {
  if (typeof v === 'number' && isFinite(v)) {
    if (v >= 19000101 && v <= 21001231) { // 数字形式的 yyyymmdd
      return parseDateCell(String(Math.floor(v)))
    }
    if (v >= 20000 && v < 100000) {
      const p = XLSX.SSF.parse_date_code(v, { date1904: !!date1904 })
      if (p && validYmd(p.y, p.m, p.d)) {
        return { date: p.y + '-' + pad2(p.m) + '-' + pad2(p.d), time: p.H || p.M ? pad2(p.H) + ':' + pad2(p.M) : '' }
      }
    }
    return null
  }
  const s = String(v == null ? '' : v).trim()
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return validYmd(+m[1], +m[2], +m[3]) ? { date: m[1] + '-' + m[2] + '-' + m[3], time: '' } : null
  m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[\sT]+(\d{1,2}):(\d{2}))?/.exec(s)
  if (!m || !validYmd(+m[1], +m[2], +m[3])) return null
  return {
    date: m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]),
    time: m[4] !== undefined && +m[4] < 24 && +m[5] < 60 ? pad2(+m[4]) + ':' + m[5] : ''
  }
}

// 独立「时间」列：'12:30[:15]' 或 Excel 的一天中的小数（0.5 = 12:00）
function parseTimeCell(v) {
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const mins = Math.round(v * 1440) % 1440
    return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60)
  }
  const m = /(\d{1,2}):(\d{2})/.exec(String(v == null ? '' : v))
  return m && +m[1] < 24 && +m[2] < 60 ? pad2(+m[1]) + ':' + m[2] : ''
}

// 金额：数字或「¥1,234.50」「-32.5」「(32.5)」；解析不出返回 NaN
function parseAmount(v) {
  if (typeof v === 'number') return v
  let s = String(v == null ? '' : v).replace(/[,，¥￥元\s]/g, '')
  let neg = false
  const p = /^\((.*)\)$/.exec(s)
  if (p) { s = p[1]; neg = true }
  s = s.replace(/^\+/, '')
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN
  return neg ? -Number(s) : Number(s)
}

// 「收/支」列的值 → 类型；'/'、不计收支等看不出方向的返回 ''
function parseDir(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s || /不计|^\/$/.test(s)) return ''
  if (/转账/.test(s)) return 'transfer'
  if (/借入|借出|债务/.test(s)) return 'debt'
  if (/支出|^支$|付款|消费/.test(s)) return 'expense'
  if (/收入|^收$|收款/.test(s)) return 'income'
  return ''
}

const text = v => String(v == null ? '' : v).trim()

// ------------------------------------------------------------------ 导入：整张表 → 流水记录
// 返回 { records, skipped: [{row, reason}], info: { hasCat, hasSub, assumedExpense } }；找不到表头返回 null
function parseSheet(aoa, date1904) {
  const head = findHeader(aoa)
  if (!head) return null
  const map = head.map
  const cell = (row, f) => (map[f] === undefined ? '' : row[map[f]])
  const noDir = map.dir === undefined && map.amount !== undefined && map.expense === undefined && map.income === undefined
  // 没有收/支列、也没有收入 / 支出分列时，只能按金额正负判断方向；全是正数就当支出
  let signed = false
  if (noDir) {
    for (let i = head.row + 1; i < aoa.length; i++) {
      if (parseAmount(cell(aoa[i] || [], 'amount')) < 0) { signed = true; break }
    }
  }
  const records = []
  const skipped = []
  for (let i = head.row + 1; i < aoa.length; i++) {
    const row = aoa[i] || []
    if (!row.some(c => text(c))) continue
    const rowNo = i + 1
    const dateRaw = cell(row, 'date')
    const amtRaw = map.amount !== undefined ? cell(row, 'amount') : ''
    // 一个金额都没有的行（合计 / 说明 / 页脚 / 只有日期的空行）不是流水，直接忽略；有金额的才逐项检查并报告原因
    if (!text(amtRaw) && !text(cell(row, 'expense')) && !text(cell(row, 'income'))) continue
    const dt = parseDateCell(dateRaw, date1904)
    if (!dt) { skipped.push({ row: rowNo, reason: '日期无法识别' }); continue }
    if (map.status !== undefined && /关闭|失败|取消|撤销/.test(text(cell(row, 'status')))) {
      skipped.push({ row: rowNo, reason: '交易未成功' }); continue
    }
    let type = map.dir !== undefined ? parseDir(cell(row, 'dir')) : ''
    let amount = map.amount !== undefined ? parseAmount(amtRaw) : NaN
    if (!(Math.abs(amount) > 0) && (map.expense !== undefined || map.income !== undefined)) {
      const e = Math.abs(parseAmount(cell(row, 'expense')))
      const inc = Math.abs(parseAmount(cell(row, 'income')))
      if (e > 0) { amount = e; type = type || 'expense' } else if (inc > 0) { amount = inc; type = type || 'income' }
    }
    if (!(Math.abs(amount) > 0)) { skipped.push({ row: rowNo, reason: '金额为空或为 0' }); continue }
    if (map.dir !== undefined && !type) { skipped.push({ row: rowNo, reason: '收支方向不明' }); continue }
    if (!type) type = signed && amount > 0 ? 'income' : 'expense'
    const parts = []
    ;['counter', 'product', 'remark', 'kind'].forEach(f => {
      const t = text(cell(row, f))
      if (t && parts.indexOf(t) < 0) parts.push(t)
    })
    records.push({
      row: rowNo,
      date: dt.date,
      time: dt.time || (map.time !== undefined ? parseTimeCell(cell(row, 'time')) : ''),
      type,
      amount: Math.round(Math.abs(amount) * 100) / 100,
      desc: parts.join(' ').slice(0, 80),
      remarkRaw: text(cell(row, 'remark')),
      catHint: text(cell(row, 'cat')),
      subHint: text(cell(row, 'sub')),
      accountText: text(cell(row, 'account')),
      toAccountText: text(cell(row, 'toAccount')),
      tag: text(cell(row, 'tag')),
      reimburse: /^(是|true|1|y|yes)$/i.test(text(cell(row, 'reimburse'))),
      id: text(cell(row, 'id')),
      ref: text(cell(row, 'ref'))
    })
    if (records.length > MAX_RECORDS) throw new Error('单次最多导入 ' + MAX_RECORDS + ' 笔，请把表格拆开分次导入')
  }
  return {
    records,
    skipped,
    info: { hasCat: map.cat !== undefined, hasSub: map.sub !== undefined, assumedExpense: noDir && !signed }
  }
}

// buffer: ArrayBuffer（.xlsx / .xls）。依次尝试每个工作表，取第一张认得出表头的；一张都不行就抛错
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'array' })
  const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904)
  for (let i = 0; i < wb.SheetNames.length; i++) {
    const name = wb.SheetNames[i]
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })
    const r = parseSheet(aoa, date1904)
    if (r) return Object.assign(r, { sheet: name })
  }
  throw new Error('没有识别到表头：表格里需要有「日期」和「金额」（或「收入 / 支出」）列')
}

// ------------------------------------------------------------------ 导入：记录 → 账单
// 稳定的短哈希（两路 FNV-1a 拼接）：同一笔流水每次导入得到同一个 id，重复导入不会重复入账
function hash(str) {
  let h1 = 0x811c9dc5
  let h2 = 0x9747b28c
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 2246822519)
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}

/**
 * records 需已分好类（catId / sub / remark）。opts: { matchAccount(text) → 账户 id | '', accountName(id) → 名称 }
 * 返回 { items: [{ bill, rec }], skipped, noAccount }（noAccount：有账户文字但没匹配上的笔数，这些记为「无账户」）
 */
function recordsToBills(records, opts) {
  const items = []
  const skipped = []
  const seen = {}
  let noAccount = 0
  records.forEach((r, idx) => {
    if (r.type === 'debt') { skipped.push({ row: r.row, reason: '借入 / 借出暂不支持 Excel 导入' }); return }
    const accountId = opts.matchAccount(r.accountText)
    if (r.accountText && !accountId && r.type !== 'transfer') noAccount++
    let toAccountId = ''
    if (r.type === 'transfer') {
      toAccountId = opts.matchAccount(r.toAccountText)
      if (!accountId || !toAccountId || accountId === toAccountId) {
        skipped.push({ row: r.row, reason: '转账需要能识别出转出、转入两个账户' }); return
      }
    }
    let id = r.id
    if (!id) {
      const base = r.ref ? 'r|' + r.ref : ['k', r.date, r.time, r.type, r.amount, r.desc, r.accountText].join('|')
      seen[base] = (seen[base] || 0) + 1 // 表里真有两笔一模一样的，按出现顺序区分
      id = 'x' + hash(base + '|' + seen[base])
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.date)
    const hm = /^(\d{2}):(\d{2})$/.exec(r.time || '')
    // createTime 取账单发生时间（而不是导入时刻）：同一笔再次导入版本相同、不会覆盖用户后来的修改，同一天内也按表里顺序排
    const createTime = new Date(+m[1], +m[2] - 1, +m[3], hm ? +hm[1] : 0, hm ? +hm[2] : 0).getTime() + idx
    const bill = {
      id, type: r.type, catId: r.type === 'transfer' ? 'transfer' : r.catId, sub: r.type === 'transfer' ? '' : r.sub,
      amount: r.amount, date: r.date, remark: r.remark || '',
      accountId, account: accountId ? opts.accountName(accountId) : '无账户',
      reimburse: r.type === 'expense' && r.reimburse, createTime
    }
    if (r.time) bill.time = r.time
    if (r.tag) bill.tag = r.tag
    if (r.type === 'transfer') { bill.toAccountId = toAccountId; bill.toAccount = opts.accountName(toAccountId) }
    items.push({ bill, rec: r })
  })
  return { items, skipped, noAccount }
}

module.exports = {
  EXPORT_HEAD, exportBuffer, debtBuffer, depositBuffer, parseWorkbook, parseSheet, recordsToBills,
  parseDateCell, parseTimeCell, parseAmount, parseDir
}
