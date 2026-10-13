// utils/util.js 通用工具

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 长 ID 中间打码：'o9SZe3dECF9dcGYLYCrSIJ3xFQ' -> 'o9SZe3...3xFQ'；太短则原样返回
function maskId(id, head, tail) {
  id = String(id || '')
  head = head == null ? 6 : head
  tail = tail == null ? 4 : tail
  return id.length > head + tail + 3 ? id.slice(0, head) + '...' + id.slice(-tail) : id
}

// 对象 -> URL 查询串：跳过 undefined/null，其余统一 encodeURIComponent（页面 onLoad 的 options 会自动解码）
function toQuery(obj) {
  return Object.keys(obj)
    .filter(k => obj[k] !== undefined && obj[k] !== null)
    .map(k => k + '=' + encodeURIComponent(obj[k]))
    .join('&')
}

function genId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// Date -> 'YYYY-MM-DD'
function dateStr(date) {
  date = date || new Date()
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

// 'YYYY-MM-DD' -> Date（本地时区）
function parseDate(str) {
  const p = str.split('-')
  return new Date(+p[0], +p[1] - 1, +p[2])
}

// 'YYYY-MM-DD' -> 'MM月DD日'
function md(str) {
  const p = str.split('-')
  return pad(+p[1]) + '月' + pad(+p[2]) + '日'
}

function weekday(str) {
  return WEEK[parseDate(str).getDay()]
}

// 月份标识 'YYYY-MM'
function monthKey(year, month) {
  return year + '-' + pad(month)
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

// 金额格式化：1234.5 -> '1234.50'
function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100
  let s = v.toFixed(2)
  return s
}

// 带千分位
function moneyThou(n) {
  const neg = n < 0
  const s = money(Math.abs(n))
  const p = s.split('.')
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + p.join('.')
}

// 固定两位小数
function fixed(n) {
  return (Number(n) || 0).toFixed(2)
}

// 去掉金额末尾多余的 0：'12.50'->'12.5'，'12.00'->'12'
function trimZero(s) {
  s = String(s)
  if (s.indexOf('.') >= 0) {
    s = s.replace(/0+$/, '').replace(/\.$/, '')
  }
  return s || '0'
}

// 时间戳 -> 'YYYY-MM-DD HH:mm'
function fullTime(ts) {
  const d = new Date(ts || Date.now())
  return dateStr(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 计算器表达式求值（仅含数字与 + - × ÷），如 '12×3+5' -> 41
function calcExpr(s) {
  s = String(s).replace(/×/g, '*').replace(/÷/g, '/')
  s = s.replace(/[-+*/.]+$/, '') // 去掉末尾悬空的运算符，如 '12+' -> '12'
  if (!s) return 0
  if (!/^[-0-9+*/.]+$/.test(s)) return Number(s) || 0
  const tokens = []
  let num = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if ((c >= '0' && c <= '9') || c === '.') {
      num += c
    } else {
      if (num !== '') { tokens.push(Number(num)); num = '' }
      if (c === '-' && (tokens.length === 0 ||
          typeof tokens[tokens.length - 1] === 'string')) {
        num = '-'
        continue
      }
      tokens.push(c)
    }
  }
  if (num !== '') tokens.push(Number(num))
  // 先乘除
  const st = [tokens[0]]
  for (let j = 1; j < tokens.length; j += 2) {
    const op = tokens[j], b = tokens[j + 1]
    if (op === '*') st.push(st.pop() * b)
    else if (op === '/') st.push(st.pop() / b)
    else { st.push(op); st.push(b) }
  }
  let r = st[0]
  for (let k = 1; k < st.length; k += 2) {
    if (st[k] === '+') r += st[k + 1]
    else r -= st[k + 1]
  }
  return Math.round(r * 100) / 100
}

// 组合支付：把总金额均分成 n 份（分为单位），余数放最后一份，保证求和精确等于原金额
function splitAmount(total, n) {
  n = Math.max(1, Math.floor(n) || 1)
  const cents = Math.round((Number(total) || 0) * 100)
  const base = Math.floor(cents / n)
  const out = []
  for (let i = 0; i < n; i++) out.push(base)
  out[n - 1] += cents - base * n
  return out.map(c => Math.round(c) / 100)
}

module.exports = {
  WEEK, pad, maskId, toQuery, genId, dateStr, parseDate, md, weekday,
  monthKey, daysInMonth, money, moneyThou,
  fixed, trimZero, fullTime, calcExpr, splitAmount
}
