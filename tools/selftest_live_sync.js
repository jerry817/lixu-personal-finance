// 多设备实时同步自测：node tools/selftest_live_sync.js（YIMU_ROOT=某目录 可指向别的版本做对照）
const { makeCloud, makeDevice } = require('./mock_sync_env')
const LABEL = 'live-sync'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL', m) } }
const has = (d, id) => d.store.getBillsSync().some(b => b.id === id)
async function waitFor(fn, ms = 1500) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(10) } return false }
const bill = (id, amt) => ({ id, type: 'expense', catId: 'food', amount: amt, date: '2026-10-11', accountId: 'a_cash', account: '现金' })
const live = d => (d.store.startLiveSync ? d.store.startLiveSync() : null)

async function scenario(name, fn) {
  const cloud = makeCloud()
  const A = makeDevice(cloud, 'u1', 'A'), B = makeDevice(cloud, 'u1', 'B')
  A.store.initDefaults(); B.store.initDefaults()
  console.log('# ' + name)
  try { await fn(cloud, A, B) } catch (e) { fail++; console.log('  EXC', e.stack) }
  if (A.store.stopLiveSync) { A.store.stopLiveSync(); B.store.stopLiveSync() }
}

;(async () => {
  await scenario('1 另一端新增 / 修改 / 删除，B 不做任何操作自动更新（监听）', async (cloud, A, B) => {
    let remote = 0
    if (B.store.onRemoteChange) B.store.onRemoteChange(() => remote++)
    await A.store.syncAll(); live(B); await sleep(60)
    A.store.addBill(bill('b1', 10))
    ok(await waitFor(() => has(B, 'b1'), 250), 'B 在远快于轮询间隔的时间内收到新增（走监听）')
    ok(remote >= 1 || !B.store.onRemoteChange, 'B 收到远端变更通知')
    await sleep(20)
    A.store.updateBill('b1', { amount: 99 })
    ok(await waitFor(() => (B.store.getBill('b1') || {}).amount === 99), 'B 收到修改')
    A.store.removeBill('b1')
    ok(await waitFor(() => !has(B, 'b1')), 'B 收到删除')
  })

  await scenario('2 监听不可用 → 轮询兜底', async (cloud, A, B) => {
    cloud.stats.watchSupported = false
    await A.store.syncAll(); live(B); await sleep(60)
    A.store.addBill(bill('b2', 5))
    ok(await waitFor(() => has(B, 'b2'), 2500), '轮询拿到新增')
  })

  await scenario('3 监听断线 → 退回轮询并自动重连', async (cloud, A, B) => {
    await A.store.syncAll(); live(B); await sleep(60)
    cloud.breakWatchers()
    A.store.addBill(bill('b3', 5))
    ok(await waitFor(() => has(B, 'b3'), 2500), '断线期间的新增被拿到')
    await sleep(400)
    ok(cloud.watchers.filter(w => !w.closed).length >= 1, '已重新建立监听')
    A.store.addBill(bill('b3b', 6))
    ok(await waitFor(() => has(B, 'b3b'), 250), '重连后恢复实时（远快于 600ms 轮询间隔）')
  })

  await scenario('4 退到后台停止同步，回前台立即追平', async (cloud, A, B) => {
    await A.store.syncAll(); live(B); await sleep(60)
    B.store.stopLiveSync()
    A.store.addBill(bill('b4', 5))
    await sleep(300)
    ok(!has(B, 'b4'), '后台期间不拉取')
    live(B)
    ok(await waitFor(() => has(B, 'b4'), 500), '回前台立即追平')
  })

  await scenario('5 本机自己的写入不会引发拉取风暴', async (cloud, A, B) => {
    await A.store.syncAll(); live(A); await sleep(60)
    const r0 = cloud.stats.reads
    for (let i = 0; i < 5; i++) A.store.addBill(bill('e' + i, i + 1))
    await sleep(400)
    const used = cloud.stats.reads - r0
    ok(used <= 8, '5 笔本机新增期间云端读取 ' + used + ' 次（应很少）')
    ok(cloud.cols.bills.e4 !== undefined, '本机新增已上云')
  })

  await scenario('6 模板 / 首页卡片 / 账户设置多端实时同步（设置文档监听）', async (cloud, A, B) => {
    await A.store.syncAll(); live(B); await sleep(60)
    A.store.addTemplate({ name: '早餐', type: 'expense', catId: 'food', amount: 8 })
    A.store.setCardConfig({ s1: 'expense', s2: 'income', s3: 'balance', sb: 'balance' })
    await A.store.flushMeta()
    // 设置文档也有监听：远快于 2 分钟（加速后 2.4s）的兜底轮询间隔
    ok(await waitFor(() => B.store.getTemplates().length === 1, 600), 'B 通过监听拿到模板')
    ok(B.store.getCardConfig().s1 === 'expense', 'B 拿到首页卡片配置')
  })

  await scenario('7 读云端设置失败时，不得用本机旧设置覆盖云端', async (cloud, A, B) => {
    // A 把账户设置推上云（时间较新）
    A.store.addTemplate({ name: '云端模板', type: 'expense', catId: 'food', amount: 1 })
    await A.store.flushMeta()
    // B 本机有一份更旧的设置：把时间调小，且改过一点东西
    B.wx.setStorageSync('meta_time', 5); B.wx.setStorageSync('budget_map', { '2026-10': 1 })
    cloud.stats.failReads = true
    try { await B.store.syncAll() } catch (e) { /* 读取失败时抛不抛都行：只检查云端设置没被覆盖 */ }
    cloud.stats.failReads = false
    const meta = cloud.cols.user_meta.u1 || {}
    ok(meta.updateTime > 5, '云端设置没有被 B 的旧设置覆盖（云端 updateTime=' + meta.updateTime + '）')
  })

  await scenario('8 无法上传的附件不会每轮同步都重写云端文档', async (cloud, A, B) => {
    await A.store.syncAll()
    A.store.addBill(Object.assign(bill('att1', 3), { attachments: [{ id: 'a1', type: 'image', name: 'x.jpg', path: '/gone.jpg' }] }))
    await sleep(80)
    await A.store.syncAll()
    const w0 = cloud.stats.writes
    await A.store.syncAll(); await A.store.syncAll(); await A.store.syncAll()
    ok(cloud.stats.writes - w0 === 0, '重复同步 3 次，额外云端写入 ' + (cloud.stats.writes - w0))
  })

  await scenario('9 同步进行中又收到远端变化：不漏', async (cloud, A, B) => {
    await A.store.syncAll(); live(B); await sleep(60)
    cloud.stats.latency = 120
    A.store.addBill(bill('f1', 1))
    await sleep(40)               // B 的同步已在途（读较慢）
    A.store.addBill(bill('f2', 2))
    ok(await waitFor(() => has(B, 'f1') && has(B, 'f2'), 3000), 'B 最终同时拿到 f1、f2')
    cloud.stats.latency = 0
  })

  await scenario('10 清空本地缓存：立即从云端恢复，且本机默认设置不覆盖云端', async (cloud, A, B) => {
    A.store.addBill(bill('c1', 1)); A.store.addBill(bill('c2', 2))
    A.store.addTemplate({ name: '云端模板', type: 'expense', catId: 'food', amount: 3 })
    await sleep(60); await A.store.flushMeta(); await A.store.syncAll()
    await B.store.syncAll(); live(B); await sleep(60)
    ok(B.store.getBillsSync().length === 2 && B.store.getTemplates().length === 1, '前置：B 已有 2 笔账单和 1 个模板')
    const cloudMetaTime = cloud.cols.user_meta.u1.updateTime
    B.store.clearLocalLedger()
    ok(B.store.getBillsSync().length === 0, '清空后本机无账单')
    // 清空后、同步前：本机若误触设置修改，也不能把默认设置推上云
    B.store.setCardConfig({ s1: 'income', s2: 'income', s3: 'income', sb: 'balance' })
    await sleep(80)
    ok(cloud.cols.user_meta.u1.updateTime === cloudMetaTime, '同步前本机设置没有被推上云覆盖云端')
    await B.store.syncFresh()
    ok(B.store.getBillsSync().length === 2, '立即全量恢复了账单')
    ok(B.store.getTemplates().length === 1, '采用云端设置：模板恢复')
    ok(!B.wx.getStorageSync('adopt_cloud_meta'), '采用标记已消耗')
  })

  await scenario('11 清空时有一次拉取正在途中：不会把「只拉了一部分」记成已拉取', async (cloud, A, B) => {
    A.store.addBill(bill('d1', 1)); A.store.addBill(bill('d2', 2)); await sleep(60); await A.store.syncAll()
    cloud.advance(10 * 60 * 1000)                 // 之后的写入都比 d1 / d2 晚 10 分钟：超出增量拉取 60 秒的回退余量
    A.store.addBill(bill('d3', 3)); await sleep(60)
    await B.store.syncAll()                       // B 的游标推进到 d3
    cloud.advance(10 * 60 * 1000)
    A.store.addBill(bill('d4', 4)); await sleep(60)
    cloud.stats.latency = 100
    const inflight = B.store.syncAll()            // 增量拉取：只会拿到 d4，拿不到 d1 / d2
    await sleep(30)
    B.store.clearLocalLedger()                    // 拉取途中清空
    await inflight.catch(() => {})
    cloud.stats.latency = 0
    await B.store.syncFresh()
    ok(['d1', 'd2', 'd3', 'd4'].every(id => has(B, id)), '清空后的同步拿回全部账单（没有因为游标漏掉 d1 / d2）：' + B.store.getBillsSync().map(b => b.id).join(','))
  })

  await scenario('12 清空前提示尚未同步的内容 / 登录后启动监听不额外同步', async (cloud, A, B) => {
    await B.store.syncAll()
    cloud.stats.failWrites = true
    B.store.addBill(bill('p1', 1)); await sleep(60)
    cloud.stats.failWrites = false
    ok(B.store.pendingSyncInfo().bills === 1, '1 笔账单尚未同步')
    await B.store.syncAll()
    ok(B.store.pendingSyncInfo().bills === 0, '同步后没有未同步内容')
    B.store.stopLiveSync(); const r0 = cloud.stats.reads
    B.store.startLiveSync({ kick: false }); await sleep(100)
    ok(cloud.stats.reads === r0, 'startLiveSync({kick:false}) 不立即同步（读取 ' + (cloud.stats.reads - r0) + ' 次）')
  })

  console.log(`\n[${LABEL}] pass=${pass} fail=${fail}`)
  process.exit(fail ? 1 : 0)
})()
