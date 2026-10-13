// utils/deposit.js 定期存款：纯函数（到期日 / 预计收益 / 文案），不碰存储。
// 存储与到期入账见 store.js 的「定期存款」一节。
//
// 定存记录：{ id, amount, rate(年利率 %), term, unit('year'|'month'|'day'), remark,
//            startDate, maturityDate, income(预计收益), accountId / account(收益入账账户，可空),
//            billed(到期收益账单已生成), createTime, updateTime }
const util = require('./util')

const UNITS = [
  { key: 'year', label: '年' },
  { key: 'month', label: '月' },
  { key: 'day', label: '天' }
]

// 存期上限：避免输入笔误算出离谱的到期日
const MAX_TERM = { year: 50, month: 600, day: 18250 }

const r2 = v => Math.round(v * 100) / 100

// 日期加 n 个月；目标月没有这一天时落在月末（1月31日 +1月 = 2月28日 / 29日）
function addMonths(dateStr, n) {
  const d = util.parseDate(dateStr)
  const day = d.getDate()
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1)
  t.setDate(Math.min(day, util.daysInMonth(t.getFullYear(), t.getMonth() + 1)))
  return util.dateStr(t)
}

function addDays(dateStr, n) {
  const d = util.parseDate(dateStr)
  d.setDate(d.getDate() + n)
  return util.dateStr(d)
}

// 到期日：存入日 + 存期；存期无效返回空串
function calcMaturity(startDate, term, unit) {
  const n = Math.floor(Number(term))
  if (!startDate || !(n > 0)) return ''
  if (unit === 'year') return addMonths(startDate, n * 12)
  if (unit === 'month') return addMonths(startDate, n)
  return addDays(startDate, n)
}

// 预计收益 = 本金 × 年利率 × 存期（年）。整存整取按单利：月 = n/12 年，天 = n/365 年
function calcIncome(amount, ratePct, term, unit) {
  const a = Number(amount)
  const r = Number(ratePct)
  const n = Math.floor(Number(term))
  if (!(a > 0) || !(r > 0) || !(n > 0)) return 0
  const years = unit === 'year' ? n : unit === 'month' ? n / 12 : n / 365
  return r2(a * r / 100 * years)
}

// 存期文案：1年 / 6个月 / 90天
function termText(term, unit) {
  return term + (unit === 'year' ? '年' : unit === 'month' ? '个月' : '天')
}

// 距到期还有几天（负数 = 已过期）
function daysLeft(maturityDate, today) {
  const a = util.parseDate(today || util.dateStr())
  const b = util.parseDate(maturityDate)
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

module.exports = { UNITS, MAX_TERM, calcMaturity, calcIncome, termText, daysLeft }
