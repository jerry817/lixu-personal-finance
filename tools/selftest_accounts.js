// 账户 / 年费 / 汇总 自测：node tools/selftest_accounts.js（YIMU_ROOT=某目录 可指向别的版本做对照）
// 覆盖：账户按 id / 名称解析（含重名、过期 id、无账户）、批量计算不随账单数增加读存储、
//       年费云同步脏数据不得拖垮启动 / 不得补记垃圾账单、年费 2 月 29 日顺延、资产汇总金额统一保留两位小数
const { makeCloud, makeDevice } = require('./mock_sync_env')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + '（得到 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）')

function device() {
  const d = makeDevice(makeCloud(), 'u1', 'A')
  d.store.initDefaults()
  let reads = 0
  const orig = d.wx.getStorageSync
  d.wx.getStorageSync = k => { reads++; return orig(k) }
  d.reads = () => reads
  d.resetReads = () => { reads = 0 }
  return d
}
const setAccounts = (d, extra) => d.wx.setStorageSync('accounts', d.store.getAccounts(true).concat(extra))
const exp = (id, amount, extra) => Object.assign({ id, type: 'expense', catId: 'food', amount, date: '2026-10-01', accountId: 'a_cash', account: '现金', createTime: 1, updateTime: 1 }, extra || {})

console.log('# 1 账户解析：id 优先 → 名称兜底 → 无账户为 null')
{
  const d = device(), s = d.store
  setAccounts(d, [{ id: 'a_dup', name: '现金', type: 'cash', initial: 7, hidden: false }]) // 与默认「现金」重名
  eq(s.accIdOf({ accountId: 'a_wechat', account: '随便' }, 'from'), 'a_wechat', 'id 存在时以 id 为准')
  eq(s.accIdOf({ accountId: 'gone', account: '招商银行' }, 'from'), 'a_cmb', 'id 已不存在时按名称找回')
  eq(s.accIdOf({ account: '现金' }, 'from'), 'a_cash', '重名账户取列表里的第一个')
  eq(s.accIdOf({ accountId: '', account: '' }, 'from'), null, '无账户（空 id + 空名称）为 null')
  eq(s.accIdOf({ accountId: 'gone', account: '不存在的名字' }, 'from'), 'gone', '名称也对不上时保留原 id')
  eq(s.accIdOf({ toAccountId: 'a_boc', toAccount: 'x' }, 'to'), 'a_boc', '转入侧同样按 toAccountId 解析')
}

console.log('# 2 批量计算读存储的次数与账单数无关')
{
  const small = device(), big = device()
  const fill = (d, n) => { const l = []; for (let i = 0; i < n; i++) l.push(exp('b' + i, 10 + (i % 7), { accountId: i % 2 ? 'a_cash' : 'a_wechat', type: i % 5 ? 'expense' : 'transfer', toAccountId: 'a_cmb' })); d.store.mergeBills(l) }
  fill(small, 50); fill(big, 2000)
  const r = d => { d.resetReads(); d.store.getAssetSummary(); const a = d.reads(); d.resetReads(); d.store.getAccountViews(); return [a, d.reads()] }
  const rs = r(small), rb = r(big)
  eq(rb, rs, '2000 笔与 50 笔账单的存储读取次数相同')
  ok(rb[0] <= 10, 'getAssetSummary 只需常数次读取（实际 ' + rb[0] + '）')
  ok(rb[1] <= 40, 'getAccountViews 读取次数只随账户数增长（实际 ' + rb[1] + '）')
}

console.log('# 3 传入 / 不传 idx 结果一致，余额口径不变')
{
  const d = device(), s = d.store
  setAccounts(d, [{ id: 'a_dup', name: '现金', type: 'cash', initial: 7, hidden: false }])
  s.mergeBills([
    exp('e1', 20), exp('e2', 5, { accountId: undefined, account: '现金' }), // 只有名称 → 归第一个「现金」
    { id: 't1', type: 'transfer', catId: 'transfer', amount: 100, fee: 1.5, date: '2026-10-02', accountId: 'a_cash', account: '现金', toAccountId: 'a_cmb', toAccount: '招商银行', createTime: 2, updateTime: 2 },
    exp('e3', 50, { refunds: [{ id: 'r1', amount: 12.5, accountId: 'a_wechat', account: '微信钱包', date: '2026-10-03' }], accountId: 'a_cmb', account: '招商银行' })
  ])
  eq(s.accountBalance('a_cash'), -126.5, '现金：-20 -5 -(100+1.5)')
  eq(s.accountBalance('a_cmb'), 50, '招商银行：+100 转入 -50 支出')
  eq(s.accountBalance('a_wechat'), 12.5, '微信钱包：收到退款 12.5')
  eq(s.accountBalance('a_dup'), 7, '重名账户只有初始余额，不被名称匹配的账单抢走')
  const ids = s.getAccounts(true).map(a => a.id)
  eq(ids.map(id => s.accountBalance(id)), ids.map(id => s.accountBalance(id, s.getBillsSync())), '显式传入账单与默认读取一致')
}

console.log('# 4 年费：云同步来的脏数据不得拖垮启动，也不得补记垃圾账单')
{
  const bad = [{ amount: 100, date: '' }, { amount: 100 }, { amount: 100, date: 'abc' }, { amount: 100, date: '2024-13-01' }, { amount: 100, date: 20241001 }]
  bad.forEach(fee => {
    const d = device(), s = d.store
    const cr = s.getAccounts(true).map(a => a.id === 'a_credit' ? Object.assign({}, a, { annualFee: fee }) : a)
    d.wx.setStorageSync('accounts', cr)
    let threw = null
    try { s.postAnnualFees() } catch (e) { threw = e.message }
    ok(!threw, '年费 ' + JSON.stringify(fee) + ' 不抛错' + (threw ? '：' + threw : ''))
    eq(s.getBillsSync().filter(b => b.id.indexOf('fee-') === 0).length, 0, '年费 ' + JSON.stringify(fee) + ' 不生成账单')
    let threw2 = null
    try { s.initDefaults() } catch (e) { threw2 = e.message }
    ok(!threw2, '年费 ' + JSON.stringify(fee) + ' 时 initDefaults（App.onLaunch 调用）不抛错')
  })
}

console.log('# 5 年费：正常补记 + 2 月 29 日在平年顺延到 28 日')
{
  const d = device(), s = d.store
  d.wx.setStorageSync('accounts', s.getAccounts(true).map(a => a.id === 'a_credit' ? Object.assign({}, a, { annualFee: { amount: 100, date: '2024-02-29' } }) : a))
  s.postAnnualFees()
  const fees = s.getBillsSync().filter(b => b.id.indexOf('fee-') === 0).sort((a, b) => a.date < b.date ? -1 : 1)
  eq(fees.map(b => b.date), ['2024-02-29', '2025-02-28', '2026-02-28'], '补记 2024（闰年 29 日）/ 2025 / 2026（28 日）')
  ok(fees.every(b => !isNaN(new Date(b.date + 'T00:00:00Z').getTime())), '所有日期都是真实存在的日期')
  const n = s.getBillsSync().length
  s.postAnnualFees(); s.postAnnualFees()
  eq(s.getBillsSync().length, n, '重复调用不会重复补记')
}

console.log('# 6 资产汇总：待报销金额与其它项一样保留两位小数')
{
  const d = device(), s = d.store
  setAccounts(d, [{ id: 'a_rb', name: '公司报销', type: 'other', group: 'debt', kind: 'reimburse', initial: 0, hidden: false }])
  s.mergeBills([0.1, 0.2].map((amt, i) => exp('rb' + i, amt, { reimburse: true, reimburseAccountId: 'a_rb', reimburseAccount: '公司报销' })))
  eq(s.getAssetSummary().reimburse, 0.3, '0.1 + 0.2 待报销显示 0.3（而不是 0.30000000000000004）')
}

console.log('# 7 已删除的无用接口不再导出')
{
  const s = device().store
  ok(s.setBudget === undefined && s.yearExpense === undefined, 'store 不再导出从未被调用的 setBudget / yearExpense')
  ok(typeof s.setMonthlyDefault === 'function' && typeof s.setMonthOverride === 'function', '预算页实际使用的写入接口仍在')
}

console.log('\n[accounts] pass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)
