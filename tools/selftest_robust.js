// 健壮性自测：node tools/selftest_robust.js（YIMU_ROOT=某目录 可指向别的版本做对照）
// 覆盖：分类被删除后的账单仍能显示（首页 / 搜索 / 账户详情都走 groupBills → decorate）、
//       残缺账单数据（null / 数字字符串 / 未知类型 / 已删账户）下所有统计接口不抛错且不出 NaN、
//       两台设备随机增改删（含云端写入失败）后账本一致、本机删除尚未上云时全量重拉不会让它复活
const { makeCloud, makeDevice } = require('./mock_sync_env')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL', m) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + '（得到 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const mk = (id, amount, extra) => Object.assign({ id, type: 'expense', catId: 'food', amount, date: '2026-10-11', accountId: 'a_cash', account: '现金' }, extra || {})
const has = (d, id) => d.store.getBillsSync().some(b => b.id === id)
function rng(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
function device() { const d = makeDevice(makeCloud(), 'u1', 'A'); d.store.initDefaults(); return d }

async function main() {
  console.log('# 1 自定义分类被删除后，账单仍能显示（删除提示写的是「已记的账单不受影响」）')
  {
    const s = device().store
    const catId = s.addCustomCat('expense', '咖啡', 'o_food')
    const incId = s.addCustomCat('income', '稿费', 'i_salary')
    ;[mk('e1', 18, { catId, sub: '拿铁' }), mk('i1', 500, { type: 'income', catId: incId }), mk('e2', 9)].forEach(b => s.addBill(b))
    eq(s.groupBills(s.getBillsSync())[0].items.map(i => i.title).sort(), ['咖啡-拿铁', '食品餐饮', '收入-稿费'].sort(), '分类存在时标题正常')
    s.removeCat('expense', catId); s.removeCat('income', incId)
    let items = null, err = null
    try { items = s.groupBills(s.getBillsSync())[0].items } catch (e) { err = e.message }
    ok(!err, '删除分类后 groupBills 不抛错' + (err ? '：' + err : ''))
    eq((items || []).map(i => i.title).sort(), ['未分类-拿铁', '食品餐饮', '收入-未分类'].sort(), '被删分类的账单显示为「未分类」，标题其余部分照旧')
    let found = null; try { found = s.search({ kw: '拿铁' }) } catch (e) { err = e.message }
    ok(found && found.length === 1, '删除分类后按备注 / 子分类搜索仍可用')
    const cs = s.categoryStats(s.getBillsSync(), 'expense', false)
    ok(cs.list.some(x => x.catId === catId && x.label === '其他'), '统计页对被删分类的兜底不变（归入「其他」）')
  }

  console.log('# 2 残缺账单数据下，所有统计接口不抛错、不出现 NaN / Infinity')
  {
    const d = device(), s = d.store
    const ids = s.getAccounts(false).map(a => a.id), bills = []
    for (let i = 0; i < 240; i++) {
      const t = i % 6, b = mk('h' + i, 3 + (i * 7) % 230, { date: '2026-' + String(1 + (i % 10)).padStart(2, '0') + '-' + String(1 + (i % 27)).padStart(2, '0'), accountId: ids[i % ids.length], createTime: 1000 + i, updateTime: 1000 + i, catId: ['food', 'shopping', 'transport', 'home'][i % 4] })
      if (t === 0) { b.type = 'income'; b.catId = 'salary' } else if (t === 3) { b.type = 'transfer'; b.catId = 'transfer'; b.toAccountId = ids[(i + 1) % ids.length] } else if (t === 5) { b.type = 'debt'; b.catId = ['borrow', 'lend', 'repay', 'collect'][i % 4] }
      if (i % 11 === 0) { b.sub = null; b.tag = null; b.remark = null }
      if (i % 13 === 0) { b.account = null; b.accountId = null }
      if (i % 17 === 0) b.catId = null
      if (i % 19 === 0) { b.refunds = null; b.attachments = null }
      if (i % 23 === 0) b.amount = String(b.amount)
      if (i % 29 === 0) b.type = 'weird'
      if (i % 31 === 0) { b.toAccountId = null; b.toAccount = null }
      if (i % 37 === 0) { b.fee = '1.5'; b.reimburse = true }
      if (i % 41 === 0) { b.accountId = 'deleted_acc'; b.account = '已删账户' }
      if (i % 43 === 0) b.amount = null
      bills.push(b)
    }
    s.mergeBills(bills)
    const all = s.getBillsSync(), bad = [], thrown = []
    const walk = (v, p) => { if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(p) } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + '[]')); else if (v && typeof v === 'object') Object.keys(v).forEach(k => { if (k !== 'raw') walk(v[k], p + '.' + k) }) }
    const call = (n, fn) => { try { walk(fn(), n) } catch (e) { thrown.push(n + ': ' + e.message) } }
    call('getAssetSummary', () => s.getAssetSummary()); call('getAccountViews', () => s.getAccountViews())
    s.getAccounts(true).forEach(a => { call('accountBalance', () => s.accountBalance(a.id)); call('accountStats', () => s.accountStats(a.id)); call('debtDetail', () => s.debtDetail(a.id)); if (s.isCreditAccount(a)) call('creditInfo', () => s.creditInfo(a.id)) })
    ;['payable', 'receivable', 'reimburse'].forEach(k => { call('getDebtViews', () => s.getDebtViews(k)); call('debtSummary', () => s.debtSummary(k)) })
    ;['2026-01', '2026-05', '2026-10'].forEach(ym => { call('getMetrics', () => s.getMetrics(ym)); call('monthDayMap', () => s.monthDayMap(ym)); call('budgetTrend', () => s.budgetTrend(ym)) })
    call('getCardMetrics', () => s.getCardMetrics()); call('tagStats', () => s.tagStats()); call('userStats', () => s.userStats())
    call('periodStats', () => s.periodStats(all, '2026-01-01', '2026-12-31'))
    ;['expense', 'income'].forEach(ty => [false, true].forEach(bySub => call('categoryStats', () => s.categoryStats(all, ty, bySub))))
    call('groupBills', () => s.groupBills(all)); call('search', () => s.search({ kw: '午餐' })); call('search-all', () => s.search({}))
    all.forEach(b => { call('netEffect', () => s.netEffect(b)); call('effectiveExpense', () => s.effectiveExpense(b)); call('billFee', () => s.billFee(b)) })
    eq(thrown.slice(0, 3), [], '70 余个统计接口在残缺数据下都不抛错')
    eq(bad.slice(0, 3), [], '返回的数字全部是有限值（无 NaN / Infinity）')
  }

  console.log('# 3 两台设备随机增改删 + 云端写入随机失败，最终账本一致且符合「后写者胜」')
  {
    let diverged = 0
    for (let seed = 1; seed <= 6; seed++) {
      const R = rng(seed), pick = a => a[Math.floor(R() * a.length)]
      const cloud = makeCloud(), A = makeDevice(cloud, 'u1', 'A'), B = makeDevice(cloud, 'u1', 'B'); A.store.initDefaults(); B.store.initDefaults()
      const devs = [A, B], oracle = {}; let n = 0
      for (let step = 0; step < 45; step++) {
        await sleep(3)
        const dev = pick(devs), r = R(), local = dev.store.getBillsSync(), offline = R() < 0.3
        if (offline) cloud.stats.failWrites = true
        if (r < 0.35 || !local.length) { const id = 'n' + (n++), amt = 1 + Math.floor(R() * 500); dev.store.addBill(mk(id, amt)); oracle[id] = { live: true, amount: amt } }
        else if (r < 0.7) { const b = pick(local), amt = 1 + Math.floor(R() * 500) + 0.5; dev.store.updateBill(b.id, { amount: amt }); oracle[b.id] = { live: true, amount: amt } }
        else if (r < 0.85) { const b = pick(local); dev.store.removeBill(b.id); oracle[b.id] = { live: false } }
        else await dev.store.syncAll()
        await sleep(3)
        if (offline) cloud.stats.failWrites = false
      }
      for (const d of [A, B, A, B, A, B]) { await d.store.syncAll(); await sleep(10) }
      const view = d => Object.fromEntries(d.store.getBillsSync().map(b => [b.id, b.amount]))
      const va = view(A), vb = view(B)
      const wrong = Object.keys(oracle).filter(id => va[id] !== vb[id] || (oracle[id].live ? va[id] !== oracle[id].amount : va[id] !== undefined))
      if (wrong.length) { diverged++; console.log('  seed', seed, '不一致：', wrong.slice(0, 3).map(id => id + ' A=' + va[id] + ' B=' + vb[id] + ' 期望=' + (oracle[id].live ? oracle[id].amount : '已删除')).join('；')) }
    }
    eq(diverged, 0, '6 组随机场景（每组 45 步）最终两端一致且与「后写者胜」一致')
  }

  console.log('# 4 本机删除尚未上云时发生全量重拉：已删除的账单不会复活')
  {
    const cloud = makeCloud(), A = makeDevice(cloud, 'u1', 'A'), B = makeDevice(cloud, 'u1', 'B'); A.store.initDefaults(); B.store.initDefaults()
    A.store.addBill(mk('x1', 10)); await sleep(10); await A.store.syncAll(); await B.store.syncAll()
    ok(has(B, 'x1'), 'B 先拿到这笔账')
    await sleep(5)
    cloud.stats.failWrites = true; A.store.removeBill('x1'); cloud.stats.failWrites = false // 删除没能上云
    A.wx.setStorageSync('sync_state', '') // 强制 A 下一次做全量拉取
    await A.store.syncAll()
    ok(!has(A, 'x1'), '全量重拉拿到云端旧版本时，不让本机已删除的账单复活')
    await A.store.syncAll(); await B.store.syncAll(); await A.store.syncAll()
    ok(!has(B, 'x1'), '删除随后同步到 B')
    ok(!!(cloud.cols.bills.x1 && cloud.cols.bills.x1.deleted), '云端文档被标记为已删除')
  }

  console.log('# 5 导入的账单没有时间戳（版本为 0）：照常导入；本机已删除的仍不复活')
  {
    const s = device().store
    const r = s.mergeBills([{ id: 'v0a', type: 'expense', catId: 'food', amount: 5, date: '2026-10-01' }, { id: 'v0b', type: 'income', catId: 'salary', amount: 9, date: '2026-10-02' }])
    eq(r.added, 2, '没有 createTime / updateTime 的账单也能导入（原先被当作「已删除」静默丢弃，却提示导入成功）')
    eq(s.getBillsSync().map(b => b.id).sort(), ['v0a', 'v0b'], '导入后账本里有这两笔')
    s.removeBill('v0a')
    eq(s.mergeBills([{ id: 'v0a', type: 'expense', catId: 'food', amount: 5, date: '2026-10-01' }]).added, 0, '本机删除过的账单，再导入无时间戳的旧数据也不复活')
    const again = s.mergeBills([{ id: 'v0b', type: 'income', catId: 'salary', amount: 123, date: '2026-10-02' }])
    eq(again.added, 0, '已存在的账单重复导入不会新增')
    eq(s.getBill('v0b').amount, 9, '无时间戳的重复导入不会覆盖已有账单')
  }

  console.log('\n[robust] pass=' + pass + ' fail=' + fail)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.log('EXC', e.stack); process.exit(1) })
