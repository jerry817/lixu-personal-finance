// utils/store.js
// 数据层：wx.storage 本地持久化；登录后账单/账户/预算的写操作会增量同步到云端。
const util = require('./util')
const cats = require('./categories')
const kinds = require('./accountKinds')
const cloud = require('./cloud')

const K_BILLS = 'bills'
const K_ADOPT = 'adopt_cloud_meta'  // 清空本地缓存后置位：下一次同步无条件采用云端的账户 / 预算设置，且在此之前不把本机设置推上云
const K_SYNC = 'sync_state'         // 云同步进度 { openid, pulled, cursor, vers }：已做过全量拉取 / 增量拉取游标 / 每笔账单云端已有的版本
const K_TOMBS = 'bill_tombs'         // 已删除账单的墓碑 { id: 删除时间 }，防止同步时被旧版本复活
const K_ACCS = 'accounts'
const K_DEPOSITS = 'time_deposits'   // 定期存款记录（随账户 / 预算一起云同步）
const K_BUDGET = 'budget_map'
const K_BUDGET_CONF = 'budget_conf'
const K_BUDGET_PERIODS = 'budget_periods' // [{ id, name, start, end, amount }]
const K_CARD = 'card_config'
const K_VIEW = 'view_mode'
const K_RANGE = 'time_range'     // 首页账单时间范围：all=全部（默认）/ month=按月
const K_CAT_PREFS = 'cat_prefs'       // 分类 / 子分类的个人设置（见「分类设置」一节），随账户 / 预算一起云同步
const K_LAST_ACC = 'last_manual_account' // 上次手动选择的收支账户
const K_TPL = 'templates'
const K_USER = 'user_profile'
const K_SEED = 'seeded_v2'            // 旧版演示数据标记（仅用于清理）
const K_CLEANED = 'demo_cleared_v1'   // 演示数据已清理标记
const K_META_TIME = 'meta_time'       // 账户/预算最近修改时间（云同步冲突判定）
const K_OWNER = 'ledger_owner'        // 本机账本归属的账号 openid（见「账本归属」一节）
const K_META_DIRTY = 'meta_dirty'     // 账户/预算有尚未推上云的改动（持久化的「待同步」标记）

// 首页卡片可展示的数据指标（group 供设置弹层分组展示）
const METRICS = [
  { key: 'todayExpense', label: '今日支出', group: '今日' },
  { key: 'todayIncome', label: '今日收入', group: '今日' },
  { key: 'todayBalance', label: '今日结余', group: '今日' },

  { key: 'weekExpense', label: '本周支出', group: '本周' },
  { key: 'weekIncome', label: '本周收入', group: '本周' },
  { key: 'weekBalance', label: '本周结余', group: '本周' },

  { key: 'expense', label: '本月支出', group: '本月' },
  { key: 'income', label: '本月收入', group: '本月' },
  { key: 'balance', label: '本月结余', group: '本月' },
  { key: 'count', label: '本月笔数', group: '本月' },
  { key: 'lastExpense', label: '最近支出', group: '本月' },

  { key: 'yearExpense', label: '本年支出', group: '本年' },
  { key: 'yearIncome', label: '本年收入', group: '本年' },
  { key: 'yearBalance', label: '本年结余', group: '本年' },

  { key: 'allExpense', label: '总支出', group: '总计' },
  { key: 'allIncome', label: '总收入', group: '总计' },
  { key: 'allBalance', label: '总结余', group: '总计' },

  { key: 'dailyAvg', label: '日均消费', group: '日均' },
  { key: 'dailyIncomeAvg', label: '日均收入', group: '日均' },

  { key: 'budgetLeft', label: '剩余预算', group: '预算' },
  { key: 'todayLeft', label: '剩余日预算', group: '预算' },
  { key: 'budgetTotal', label: '预算总额', group: '预算' },
  { key: 'dailyBudget', label: '日均预算', group: '预算' },

  { key: 'totalAssets', label: '总资产', group: '资产' },
  { key: 'totalLiability', label: '负资产', group: '资产' },
  { key: 'netAssets', label: '净资产', group: '资产' }
]

const DEFAULT_CARD = { s1: 'income', s2: 'balance', s3: 'budgetLeft', sb: 'expense' }

const DEFAULT_BUDGET_CONF = {
  carry: false,      // 多余预算累加至下月
  overcut: false     // 超额支出从下月扣除
}

// ------------------------------------------------------------- 账户定义
function defaultAccounts() {
  return [
    { id: 'a_cash', name: '现金', type: 'cash', icon: '/images/acc/acc_cash.png', initial: 0, hidden: false },
    { id: 'a_wechat', name: '微信钱包', type: 'wechat', icon: '/images/acc/acc_wechat.png', initial: 0, hidden: false },
    { id: 'a_alipay', name: '支付宝', type: 'alipay', icon: '/images/acc/acc_alipay.png', initial: 0, hidden: false },
    { id: 'a_cmb', name: '招商银行', type: 'bank', icon: '/images/acc/acc_bank.png', initial: 0, hidden: false },
    { id: 'a_boc', name: '中国银行', type: 'bank', icon: '/images/acc/acc_bank.png', initial: 0, hidden: false },
    { id: 'a_mybank', name: '网商银行', type: 'bank', icon: '/images/acc/acc_bank.png', initial: 0, hidden: false },
    { id: 'a_credit', name: '信用卡', type: 'credit', icon: '/images/acc/acc_credit.png', initial: 0, hidden: false }
  ]
}

// ------------------------------------------------------------- 基础读写
function getBillsSync() {
  return wx.getStorageSync(K_BILLS) || []
}

// 本地存储的写入统一从这里走：每次写入 / 删除都让 revision 加一，页面据此判断「自上次渲染以来数据有没有变」，
// 没变就不必重新计算和渲染（首页 onShow）。store 以外的页面不直接写存储，所以 revision 覆盖所有数据变化
let rev = 0

function put(key, value) {
  rev++
  wx.setStorageSync(key, value)
}

function drop(key) {
  if (wx.getStorageSync(key) === '') return // 本来就没有：没有任何变化（如同步时清一个不存在的标记）
  rev++
  wx.removeStorageSync(key)
}

function revision() {
  return rev
}

function writeAll(list) {
  put(K_BILLS, list)
  emitChange()
}

// ------------------------------------------------------------- 数据变更通知
// 账单 / 账户 / 预算任何一处写入后通知订阅页刷新（例如预算页的趋势图：账单在后台云同步、
// 或在别处被改动后，页面不必等下一次 onShow 就能跟着重算）。回调里出错不影响写入本身。
const changeListeners = []

function subscribe(fn) {
  changeListeners.push(fn)
  return function unsubscribe() {
    const i = changeListeners.indexOf(fn)
    if (i >= 0) changeListeners.splice(i, 1)
  }
}

function emitChange() {
  changeListeners.slice().forEach(fn => {
    try { fn() } catch (e) { console.warn('[store] change listener', e) }
  })
}

// 账单版本号：每次编辑刷新 updateTime，同步时版本高者胜；老数据没有该字段，回退到 createTime
function ver(b) {
  return b.updateTime || b.createTime || 0
}

function getTombs() {
  return wx.getStorageSync(K_TOMBS) || {}
}

// 云端墓碑文档：删除也是一次带版本号的「写入」，其它设备才能收到并跟随删除。
// 同时带 createTime：云端按 createTime 排序分页，缺该字段的文档在部分环境可能漏排。
function tombDoc(id, time) {
  return { id, deleted: true, updateTime: time, createTime: time }
}

// 云同步进度：按账号隔离（换账号读到的是空进度，会重新做一次全量拉取）。
// vers 记录「云端已有这笔账单的哪个版本」，推送时据此只传比云端新的账单；
// 增量拉取后手里只有变化的那几条云端文档，没法再靠「云端有没有这条」来判断
function getSyncState() {
  const openid = cloud.getOpenid()
  const st = wx.getStorageSync(K_SYNC)
  return st && st.openid === openid ? st : { openid, pulled: false, cursor: 0, vers: {} }
}

// 读 → 改 → 写在同一步里完成：登录后的增量推送与完整同步可能交错，不能各自拿着旧副本回写
function updateSyncState(fn) {
  if (!cloud.isLoggedIn()) return
  const st = getSyncState()
  fn(st)
  wx.setStorageSync(K_SYNC, st) // 同步进度不是页面展示的数据，不走 put（否则每次同步都会让首页白白重渲染）
}

function markCloudVer(id, v) {
  updateSyncState(st => { st.vers[id] = v })
}

// 把账单里还没有 fileID 的附件上传到云存储，并把 fileID 回填到本地账单。
// resolve 上传失败的附件数；单个附件失败不影响其它附件，也不阻塞账单本身入库。
function uploadBillAttachments(bill) {
  const atts = Array.isArray(bill.attachments) ? bill.attachments : []
  const pending = atts.filter(a => a && !a.fileID)
  if (!pending.length) return Promise.resolve(0)
  let failed = 0
  const ids = {} // 附件 id -> 上传得到的 fileID（不直接改传入对象：组合支付的多笔账单可能共用同一批附件对象）
  return Promise.all(pending.map(a =>
    cloud.uploadAttachment(a, bill.id)
      .then(fileID => { ids[a.id] = fileID })
      .catch(e => { failed++; console.warn('[sync] attachment', a.id, e) })
  )).then(() => {
    // 重新读取本地账单，按附件 id 回填，避免覆盖上传期间用户做的其它修改。
    // 回填会刷新版本号：附件补传成功后云端文档内容变了（多了 fileID），其它设备已拿到旧文档，
    // 版本不变就会按「版本相同保留本机」永远收不到这些附件
    const list = getBillsSync()
    const cur = list.find(x => x.id === bill.id)
    if (cur && Array.isArray(cur.attachments)) {
      let changed = false
      cur.attachments.forEach(ca => {
        if (ids[ca.id] && !ca.fileID) { ca.fileID = ids[ca.id]; changed = true }
      })
      if (changed) { cur.updateTime = Date.now(); writeAll(list) }
    }
    return failed
  })
}

// 先传附件、再写账单文档（文档里只存 fileID）。resolve 上传失败的附件数
function uploadAndSync(bill) {
  return uploadBillAttachments(bill).then(failed => {
    const cur = getBill(bill.id)
    if (!cur) return failed // 上传期间账单已被删除，不要把它写回云端
    // 云端已经是这个版本、只是附件还没传上去：云端文档内容不会因此变化（没有 fileID 的附件不入库），
    // 不必再写一次——否则前台每轮同步都会为它白写一次云端并让所有设备多拉一次
    const known = getSyncState().vers[cur.id]
    if (failed && known !== undefined && known >= ver(cur)) return failed
    return Promise.resolve(cloud.syncBill(cur)).then(ok => {
      if (ok !== false) markCloudVer(cur.id, ver(cur))
      return failed
    })
  })
}

// 登录后的增量同步：失败只记日志，下次手动「云同步」会补传
function pushBill(b) {
  if (!cloud.isLoggedIn()) return
  uploadAndSync(b).then(failed => {
    if (failed) wx.showToast({ title: '附件上传失败，同步时将重试', icon: 'none' })
  }).catch(e => console.warn('[sync] push', e))
}

// 云端写入墓碑（其它设备同步时据此删除），并删除附件文件
function dropBill(id, time, attachments) {
  if (!cloud.isLoggedIn()) return
  Promise.resolve(cloud.syncBill(tombDoc(id, time)))
    .then(ok => { if (ok !== false) markCloudVer(id, time) })
    .catch(e => console.warn('[sync] drop', e))
  cloud.deleteFiles((attachments || []).map(a => a && a.fileID))
}

function getBill(id) {
  return getBillsSync().find(b => b.id === id)
}

function billDefaults() {
  return {
    id: util.genId(),
    type: 'expense',
    catId: 'other',
    sub: '',
    amount: 0,
    date: util.dateStr(),
    accountId: 'a_wechat',
    account: '微信钱包',
    toAccountId: 'a_mybank',
    toAccount: '网商银行',
    remark: '',
    tag: '',
    reimburse: false
  }
}

// 补全必填字段（主要是 date），避免残缺数据让 monthBills/yearExpense/periodExpense 等按日期读取的函数崩溃
function normalizeBill(b) {
  const bill = Object.assign(billDefaults(), b)
  if (typeof bill.date !== 'string' || !bill.date) bill.date = util.dateStr()
  bill.amount = Number(bill.amount) || 0
  // 每笔账单持有独立的附件对象（组合支付会把同一批附件分给多笔账单）
  if (Array.isArray(bill.attachments)) bill.attachments = bill.attachments.map(a => Object.assign({}, a))
  return bill
}

function addBill(data) {
  const list = getBillsSync()
  const bill = normalizeBill(data)
  bill.createTime = Date.now()
  list.push(bill)
  writeAll(list)
  pushBill(bill)
  return bill
}

function updateBill(id, patch) {
  const list = getBillsSync()
  const i = list.findIndex(b => b.id === id)
  if (i < 0) return null
  const before = Array.isArray(list[i].attachments) ? list[i].attachments : []
  list[i] = Object.assign(list[i], patch, { updateTime: Date.now() })
  writeAll(list)
  // 编辑时被移除的附件：同步清理云存储里的对应文件
  const kept = {}
  ;(list[i].attachments || []).forEach(a => { if (a && a.fileID) kept[a.fileID] = true })
  const dropped = before.filter(a => a && a.fileID && !kept[a.fileID])
  if (dropped.length && cloud.isLoggedIn()) cloud.deleteFiles(dropped.map(a => a.fileID))
  pushBill(list[i])
  return list[i]
}

function removeBill(id) {
  const old = getBill(id)
  if (!old) return
  const now = Date.now()
  writeAll(getBillsSync().filter(b => b.id !== id))
  const tombs = getTombs()
  tombs[id] = now
  put(K_TOMBS, tombs)
  dropBill(id, now, old.attachments)
}

// 合并附件：云端附件只有 fileID，沿用本机已有的本地路径以便离线查看；
// 本机尚未上传成功（无 fileID）的附件保留，等待下次同步上传
function mergeAttachments(localAtts, remoteAtts) {
  const local = Array.isArray(localAtts) ? localAtts : []
  const remote = Array.isArray(remoteAtts) ? remoteAtts : []
  const byId = {}
  local.forEach(a => { if (a && a.id) byId[a.id] = a })
  const out = remote.map(r => {
    const l = byId[r.id]
    return l && l.path ? Object.assign({}, r, { path: l.path }) : r
  })
  local.forEach(l => {
    if (l && !l.fileID && !remote.some(r => r.id === l.id)) out.push(l)
  })
  return out
}

// 与云端/外部账单合并：按 id 去重，版本（updateTime，缺省 createTime）高者胜；
// 墓碑（deleted）按同样规则生效：删除晚于最后一次编辑则删，之后又被编辑过则保留
function mergeBills(incoming) {
  const map = {}
  getBillsSync().forEach(b => { map[b.id] = b })
  const tombs = getTombs()
  let added = 0
  let changed = false // 增量拉取带 60 秒余量会重复拿到刚同步过的文档：没有实际变化就不重写本地账单
  ;(incoming || []).forEach(raw => {
    if (!raw || !raw.id) return
    const rv = ver(raw)
    if (raw.deleted) {
      if ((tombs[raw.id] || 0) < rv) { tombs[raw.id] = rv; changed = true }
      if (map[raw.id] && ver(map[raw.id]) <= rv) { delete map[raw.id]; changed = true }
      return
    }
    if (tombs[raw.id] !== undefined && tombs[raw.id] >= rv) return // 本机已删除这笔账，不让旧版本复活（没有墓碑就不算已删除：无时间戳的导入账单 rv 为 0）
    const b = normalizeBill(raw)
    b.id = raw.id // normalizeBill 会用 billDefaults 里的随机 id 兜底，这里需要保留原始 id
    const old = map[b.id]
    if (!old) { map[b.id] = b; added++; changed = true }
    else if (rv > ver(old)) {
      b.attachments = mergeAttachments(old.attachments, b.attachments)
      map[b.id] = b
      changed = true
    }
  })
  const list = Object.values(map)
  if (changed) {
    writeAll(list)
    put(K_TOMBS, tombs)
  }
  return { total: list.length, added, changed }
}

// 清空全部本地账单与预算数据（不影响云端）
// 清空代数：清空发生时递增。清空前就已发出的拉取回来时会发现代数变了，直接丢弃（见 pullFromCloud）
let epoch = 0

function clearAllData() {
  epoch++
  drop(K_BILLS)
  drop(K_TOMBS)
  wx.removeStorageSync(K_SYNC) // 本机账单没了，同步进度作废：下次重新全量拉取
  drop(K_BUDGET)
  drop(K_BUDGET_CONF)
  drop(K_BUDGET_PERIODS)
  emitChange()
}

// 清空本机全部账本数据（账单、账户、预算、定存、分类设置）。
// 只在用户主动「清空本地缓存」、或登录时确认「清掉另一个账号留在本机的数据」时调用；退出登录不会调用它
function clearLocalLedger() {
  clearAllData()
  drop(K_ACCS)
  drop(K_DEPOSITS)
  drop(K_CAT_PREFS)
  drop(K_META_TIME)
  drop(K_META_DIRTY)
  drop(K_OWNER)
  // 已登录时清缓存：云端是准的，本机马上要从云端恢复。置位后下一次同步直接采用云端设置，
  // 同步前本机默认设置不会被当成「更新」推上去覆盖云端（未登录的清空没有云端可采用，不置位）
  if (cloud.isLoggedIn()) wx.setStorageSync(K_ADOPT, 1)
  emitChange()
}

// ------------------------------------------------------------- 本机账本归属（防串号）
// 退出登录后账本继续留在本机（离线 / 游客模式）。为避免「A 退出、B 登录，A 的账单被同步进 B 的云端」，
// 记下本机账本最后一次同步所属的账号 openid：
//   · 从未登录过的游客账本没有归属，第一次登录的账号直接认领（含登录前记的账）；
//   · 同一账号重新登录：游客期间记的账照常合并上云；
//   · 另一个账号登录：不能直接合并，由登录流程让用户选择（清空本机数据后登录 / 取消），见 pages/profile。
function getLedgerOwner() {
  return wx.getStorageSync(K_OWNER) || ''
}

function claimLedger(openid) {
  if (openid) put(K_OWNER, openid)
}

// 本机账本是否属于另一个账号（有归属且不是 openid）
function ledgerOwnedByOther(openid) {
  const owner = getLedgerOwner()
  return !!owner && owner !== openid
}

// ------------------------------------------------------------- 云同步
function metaTime() {
  return wx.getStorageSync(K_META_TIME) || 0
}

function getMeta() {
  return {
    accounts: getAccounts(true),
    time_deposits: getDeposits(),
    budget_map: getBudgetMap(),
    budget_conf: getBudgetConf(),
    budget_periods: getBudgetPeriods(),
    cat_prefs: wx.getStorageSync(K_CAT_PREFS) || {},
    templates: getTemplates(),
    card_config: wx.getStorageSync(K_CARD) || null,
    updateTime: metaTime()
  }
}

function applyMeta(m) {
  if (!m) return
  if (Array.isArray(m.accounts) && m.accounts.length) put(K_ACCS, m.accounts)
  if (Array.isArray(m.time_deposits)) put(K_DEPOSITS, m.time_deposits)
  if (m.budget_map) put(K_BUDGET, m.budget_map)
  if (m.budget_conf) put(K_BUDGET_CONF, m.budget_conf)
  if (Array.isArray(m.budget_periods)) put(K_BUDGET_PERIODS, m.budget_periods)
  if (m.cat_prefs) put(K_CAT_PREFS, m.cat_prefs)
  if (Array.isArray(m.templates)) put(K_TPL, m.templates)   // 旧版本写入的云端文档没有这两项：缺省时保留本机的
  if (m.card_config) put(K_CARD, m.card_config)
  put(K_META_TIME, m.updateTime || 0)
  emitChange()
}

// 账户 / 预算发生变化：记录时间 + 标记「待同步」，并（已登录时）排队推送到云端。
// 推送队列保证：
//   · 合并：一次保存里连续改多个设置（每月预算 / 本月预算 / 结转开关…）只推最后一份完整快照；
//   · 串行：同一时刻只有一个写入在途，后一份快照一定在前一份之后到达，不会被旧快照覆盖；
//   · 重试：失败（断网 / 云端报错）按指数退避自动重试；「待同步」标记持久化，重启后仍会补推。
const META_DEBOUNCE = 400
let metaTimer = null
let metaInflight = null
let metaAgain = false
let metaRetry = 0

function touchMeta() {
  put(K_META_TIME, Date.now())
  put(K_META_DIRTY, 1)
  emitChange()
  scheduleMetaPush(META_DEBOUNCE)
}

function scheduleMetaPush(delay) {
  if (!cloud.isLoggedIn()) return
  clearTimeout(metaTimer)
  metaTimer = setTimeout(() => { runMetaPush() }, delay)
}

// 立即推送一次（队列保证串行）。resolve：true=已同步；false=未同步（失败，已安排重试）；null=未登录（登录后自动补推）
function runMetaPush() {
  if (!cloud.isLoggedIn()) return Promise.resolve(null)
  if (wx.getStorageSync(K_ADOPT)) return Promise.resolve(null) // 清缓存后先采用云端设置，不推本机的
  clearTimeout(metaTimer)
  if (metaInflight) { metaAgain = true; return metaInflight }
  const snap = getMeta()
  metaInflight = Promise.resolve(cloud.syncMeta(snap))
    .then(r => {
      if (r === false) throw new Error('cloud-not-ready')
      metaRetry = 0
      // 推送期间没有新改动才清标记；有新改动则 metaAgain 会再推一次
      if (metaTime() === snap.updateTime) drop(K_META_DIRTY)
      return true
    })
    .catch(e => {
      console.warn('[sync] meta', e)
      metaRetry++
      if (metaRetry <= 6) scheduleMetaPush(Math.min(30000, 1000 * Math.pow(2, metaRetry - 1)))
      return false
    })
    .then(ok => {
      metaInflight = null
      if (metaAgain) { metaAgain = false; scheduleMetaPush(0) }
      return ok
    })
  return metaInflight
}

// 页面保存后调用：不等防抖，马上推并返回结果（用于「已同步云端」提示）
function flushMeta() {
  return runMetaPush()
}

// 本机有未同步成功的账户 / 预算改动 → 补推（启动 / 回到首页时调用）
function retryMetaIfDirty() {
  if (wx.getStorageSync(K_META_DIRTY)) scheduleMetaPush(0)
}

// 只上传比云端新的内容：云端没有的账单、本机版本更高的账单、还有附件没传完的账单，
// 以及比云端文档更晚的删除墓碑（「云端有什么」以同步进度里的 vers 为准）。
// failed = 写入失败数；attachFailed = 附件上传失败数
function pushChanged() {
  const vers = getSyncState().vers
  const tombs = getTombs()
  const jobs = getBillsSync()
    .filter(b => !(b.id in vers) || ver(b) > vers[b.id] || (b.attachments || []).some(a => a && !a.fileID))
    .map(b => () => uploadAndSync(b))
    .concat(Object.keys(tombs)
      .filter(id => id in vers && tombs[id] > vers[id])
      .map(id => () => Promise.resolve(cloud.syncBill(tombDoc(id, tombs[id]))).then(ok => {
        if (ok !== false) markCloudVer(id, tombs[id])
        return 0
      })))
  let failed = 0
  let attachFailed = 0
  const batches = []
  for (let i = 0; i < jobs.length; i += 10) batches.push(jobs.slice(i, i + 10))
  return batches.reduce((p, batch) => p.then(() =>
    Promise.all(batch.map(job => job().then(n => { attachFailed += n }).catch(() => { failed++ })))
  ), Promise.resolve()).then(() => ({ failed, attachFailed }))
}

function reconcileMeta() {
  return cloud.loadMeta().then(remote => {
    const local = metaTime()
    const rt = remote ? (remote.updateTime || 0) : -1
    const adopt = !!wx.getStorageSync(K_ADOPT)
    if (remote && (adopt || rt > local)) {
      applyMeta(remote); drop(K_META_DIRTY)
      wx.removeStorageSync(K_ADOPT)
      return 'pulled'
    }
    wx.removeStorageSync(K_ADOPT) // 云端没有设置文档：没有可采用的，恢复正常的「新者为准」
    if (local > 0 && rt < local) {
      // 本机更新：走推送队列（串行 + 失败重试），失败则让同步结果如实报错而不是假装成功
      return runMetaPush().then(ok => (ok === false ? Promise.reject(new Error('meta-push-failed')) : 'pushed'))
    }
    drop(K_META_DIRTY)
    return 'same'
  })
}

// 拉取云端账单并合并到本地，同时对齐账户 / 预算（两者并行）。
// 该设备第一次同步全量拉取，之后只拉云端写入时间晚于游标的账单；没有变化时本地账单一个字节都不重写。
// 拉回了其它设备的改动（账单或账户 / 预算）时通知 onRemoteChange 的订阅者，让当前页面重新读取本地数据
function pullFromCloud() {
  if (!cloud.isLoggedIn()) return Promise.reject(new Error('not-logged-in'))
  const st = getSyncState()
  const ep = epoch
  return Promise.all([
    cloud.loadCloudBills(st.pulled ? st.cursor : null),
    reconcileMeta().catch(e => { console.warn('[sync] meta', e) })
  ]).then(([res, metaResult]) => {
    // 拉取期间本机被清空：这批文档是按清空前的游标取的，只是云端的一部分，不能合并、更不能据此记「已拉过」，
    // 否则之后的增量拉取会永远漏掉更早的账单。丢弃即可，随后的同步会重新全量拉取
    if (ep !== epoch) return { total: getBillsSync().length, added: 0, changed: false, metaPulled: metaResult === 'pulled' }
    const r = res.docs.length ? mergeBills(res.docs) : { total: getBillsSync().length, added: 0, changed: false }
    updateSyncState(s => {
      res.docs.forEach(d => { s.vers[d.id] = ver(d) })
      s.cursor = Math.max(s.cursor, res.cursor)
      s.pulled = true
    })
    r.metaPulled = metaResult === 'pulled'
    if (r.changed || r.metaPulled) emitRemote()
    return r
  })
}

// 完整同步：先拉取并按版本合并，再只上传比云端新的部分（顺序不能反：先推会让旧数据覆盖云端新数据）。
// 同一时刻只跑一次：登录后的后台同步、首页静默同步、手动「云同步」同时触发时共用同一个进行中的同步，
// 不会并发重复上传附件 / 账单
let syncInflight = null
let syncQueued = null

function syncAll() {
  if (syncInflight) return syncInflight
  const done = () => { syncInflight = null }
  syncInflight = pullFromCloud().then(r => pushChanged().then(push => ({
    total: r.total, added: r.added, changed: r.changed || r.metaPulled, failed: push.failed, attachFailed: push.attachFailed
  })))
  syncInflight.then(done, done)
  return syncInflight
}

// 「再同步一次」：已有同步在跑时，它的拉取可能早于刚收到的远端变化，直接共用会漏掉；
// 这里排到当前同步之后再跑一次（多次请求合并成一次排队）。没有同步在跑就等同于 syncAll
function syncFresh() {
  if (!syncInflight) return syncAll()
  if (!syncQueued) {
    const next = () => { syncQueued = null; return syncAll() }
    syncQueued = syncInflight.then(next, next)
  }
  return syncQueued
}

// ------------------------------------------------------------- 多端实时同步
// 为什么需要它：同步只发生在启动 / 首页 / 手动点击时，另一台设备记账、删账后，这台设备停留的页面永远收不到。
// 现在 App 在前台期间一直保持：
//   · 实时监听（cloud.watchBills）：其它设备写入云端后几百毫秒内触发一次同步；
//   · 轮询兜底：监听没连上（基础库不支持 / 断线重连中）时每 30 秒同步一次，连上时每 2 分钟一次（防监听漏事件）；
//   · 回到前台立即同步一次；退到后台就停掉监听和定时器，不耗电、不耗云调用。
// 同步结果有变化时 store 通过 onRemoteChange 通知 App，由 App 让当前页面重新读取（页面实现 onDataChanged）。
const LIVE_POLL_FAST = 30000
const LIVE_POLL_SLOW = 120000
const LIVE_DEBOUNCE = 600       // 连续几次写入合并成一次同步
const LIVE_RETRY_BASE = 5000    // 监听断开后的重连间隔：5s、10s、20s……最长 60s

const live = { on: false, openid: '', poll: null, deb: null, watcher: null, metaWatcher: null, gen: 0, retry: 0, retryTimer: null }
const remoteListeners = []

function onRemoteChange(fn) {
  remoteListeners.push(fn)
  return function off() {
    const i = remoteListeners.indexOf(fn)
    if (i >= 0) remoteListeners.splice(i, 1)
  }
}

function emitRemote() {
  remoteListeners.slice().forEach(fn => {
    try { fn() } catch (e) { console.warn('[store] remote listener', e) }
  })
}

// 监听事件里的文档是不是「本机还不知道的版本」：本机自己刚写出去的文档（回声）版本等于 vers，不需要再同步
function hasForeignChange(docs) {
  if (!docs || !docs.length) return true // 说不清变了什么，宁可多同步一次
  const vers = getSyncState().vers
  return docs.some(d => !d || !d.id || !(d.id in vers) || ver(d) > vers[d.id])
}

function liveSync() {
  if (!live.on) return Promise.resolve()
  if (!cloud.isLoggedIn() || cloud.getOpenid() !== live.openid) { stopLiveSync(); return Promise.resolve() }
  return syncFresh().catch(e => { console.warn('[live] sync', e) })
}

function liveKick(delay) {
  clearTimeout(live.deb)
  live.deb = setTimeout(liveSync, delay)
}

function scheduleLivePoll() {
  clearTimeout(live.poll)
  if (!live.on) return
  live.poll = setTimeout(() => { liveSync().then(scheduleLivePoll) }, live.watcher ? LIVE_POLL_SLOW : LIVE_POLL_FAST)
}

function closeLiveWatcher() {
  live.gen++ // 让已关闭监听的迟到回调（含 onError）失效
  const ws = [live.watcher, live.metaWatcher]
  live.watcher = null
  live.metaWatcher = null
  ws.forEach(w => { if (w) Promise.resolve(w.close()).catch(() => {}) })
}

// 设置文档的变化事件：云端设置比本机新才算「别的设备改的」（本机自己刚推的，updateTime 与本机一致）
function hasForeignMeta(docs) {
  if (!docs || !docs.length) return true
  const mine = metaTime()
  return docs.some(d => !d || (d.updateTime || 0) > mine)
}

// 同时监听账单（最新一条）和账户 / 预算设置：任何一边被其它设备改动，都防抖后同步一次
function openLiveWatcher() {
  if (!live.on || live.watcher) return
  const gen = ++live.gen
  const onErr = err => {
    if (gen !== live.gen) return // 已被关闭 / 已被新监听取代，两个监听先后报错只处理一次
    console.warn('[live] watch error', err)
    closeLiveWatcher()
    if (!live.on) return
    // 断线后退回快速轮询，并按指数退避重连
    scheduleLivePoll()
    clearTimeout(live.retryTimer)
    live.retryTimer = setTimeout(() => {
      openLiveWatcher()
      if (live.watcher) liveKick(0) // 断线期间可能漏了变化，重连成功后补同步一次
    }, Math.min(60000, LIVE_RETRY_BASE * Math.pow(2, live.retry++)))
  }
  const w = cloud.watchBills(docs => { if (hasForeignChange(docs)) liveKick(LIVE_DEBOUNCE) }, onErr)
  if (!w) return
  live.watcher = w
  live.metaWatcher = cloud.watchMeta(docs => { if (hasForeignMeta(docs)) liveKick(LIVE_DEBOUNCE) }, onErr)
  live.retry = 0
}

// App 回到前台 / 登录成功后调用；已经在运行时等同于「立即同步一次」。
// opts.kick === false：只启动监听和轮询，不立即同步（调用方自己马上要跑一次同步，如登录后）
function startLiveSync(opts) {
  if (!cloud.ready() || !cloud.isLoggedIn()) return
  const kick = !(opts && opts.kick === false)
  if (live.on && live.openid === cloud.getOpenid()) { if (kick) liveKick(0); return }
  stopLiveSync()
  live.on = true
  live.openid = cloud.getOpenid()
  openLiveWatcher()
  if (kick) liveKick(0)
  scheduleLivePoll()
}

// App 退到后台 / 退出登录时调用
function stopLiveSync() {
  live.on = false
  live.openid = ''
  live.retry = 0
  clearTimeout(live.poll)
  clearTimeout(live.deb)
  clearTimeout(live.retryTimer)
  closeLiveWatcher()
}

// 供页面判断当前是否已登录云（决定下拉刷新走网络同步还是仅本地刷新）
function cloudLoggedIn() {
  return cloud.isLoggedIn()
}

// 还没同步到云端的本机改动（清空本地缓存前提醒用）：{ bills: 账单新增 / 修改 / 删除的笔数, meta: 账户 / 预算设置有未推送的修改 }。
// 本设备还没做过首次拉取时不知道云端有什么，不统计账单（避免把「全部账单」误报成未同步）
function pendingSyncInfo() {
  if (!cloud.isLoggedIn()) return { bills: 0, meta: false }
  const st = getSyncState()
  let bills = 0
  if (st.pulled) {
    const tombs = getTombs()
    bills = getBillsSync().filter(b => !(b.id in st.vers) || ver(b) > st.vers[b.id] || (b.attachments || []).some(a => a && !a.fileID)).length +
      Object.keys(tombs).filter(id => id in st.vers && tombs[id] > st.vers[id]).length
  }
  return { bills, meta: !!wx.getStorageSync(K_META_DIRTY) }
}

// ------------------------------------------------------------- 账户
function getAccounts(includeHidden) {
  let list = wx.getStorageSync(K_ACCS)
  if (!list || !list.length) {
    list = defaultAccounts()
    put(K_ACCS, list)
  }
  return includeHidden ? list : list.filter(a => !a.hidden)
}

function getAccount(id) {
  return getAccounts(true).find(a => a.id === id)
}

function saveAccount(data) {
  const list = getAccounts(true)
  if (data.id) {
    const i = list.findIndex(a => a.id === data.id)
    if (i >= 0) list[i] = Object.assign(list[i], data)
  } else {
    data.id = util.genId()
    list.push(data)
  }
  put(K_ACCS, list)
  touchMeta()
  return data
}

function removeAccount(id) {
  put(K_ACCS, getAccounts(true).filter(a => a.id !== id))
  touchMeta()
}

// 按给定 id 顺序重排账户（长按拖动排序）；未出现在 orderedIds 中的账户保留在原有顺序之后
function reorderAccounts(orderedIds) {
  const list = getAccounts(true)
  const byId = {}
  list.forEach(a => { byId[a.id] = a })
  const seen = {}
  const out = []
  orderedIds.forEach(id => {
    if (byId[id] && !seen[id]) { out.push(byId[id]); seen[id] = true }
  })
  list.forEach(a => { if (!seen[a.id]) out.push(a) })
  put(K_ACCS, out)
  touchMeta()
  return out
}

// 转账手续费（仅转账账单有；其余类型恒为 0）。保留两位小数，避免浮点尾差
// 债务账户上的还款 / 收款也可以带手续费；其余类型恒为 0
function billFee(b) {
  if (!b) return 0
  if (b.type !== 'transfer' && !(b.type === 'debt' && (b.catId === 'repay' || b.catId === 'collect'))) return 0
  const f = Number(b.fee)
  return f > 0 ? Math.round(f * 100) / 100 : 0
}

// 账户索引：一次读取账户列表，供批量解析（逐笔账单反复调 getAccount 会每次都读一遍本地存储，
// 账单上千笔时一次余额计算就是上万次同步读取）。重名账户取第一个，与逐个 find 的结果一致
function accountIndex() {
  const byId = new Map()
  const byName = new Map()
  getAccounts(true).forEach(a => {
    if (!byId.has(a.id)) byId.set(a.id, a)
    if (!byName.has(a.name)) byName.set(a.name, a.id)
  })
  return { byId, byName }
}

// 账单 -> 账户ID（兼容无 accountId 的旧数据，按名称匹配）。批量调用时传入 accountIndex() 的结果 idx
function accIdOf(b, role, idx) {
  const id = role === 'to' ? b.toAccountId : b.accountId
  const name = role === 'to' ? b.toAccount : b.account
  const ix = idx || accountIndex()
  if (id && ix.byId.has(id)) return id
  return ix.byName.has(name) ? ix.byName.get(name) : (id || null)
}

// 账户余额（由初始余额 + 全部相关账单实时计算）。批量调用（遍历所有账户）时传入同一个 idx，只读一次账户列表
function accountBalance(accId, bills, idx) {
  const ix = idx || accountIndex()
  const acc = ix.byId.get(accId)
  let v = acc ? acc.initial : 0
  bills = bills || getBillsSync()
  bills.forEach(b => {
    const from = accIdOf(b, 'from', ix)
    if (b.type === 'income' && from === accId) v += b.amount
    else if (b.type === 'expense' && from === accId) v -= b.amount
    else if (b.type === 'transfer') {
      // 手续费由转出账户另付：转出 −(金额 + 手续费)，转入 +金额
      if (from === accId) v -= b.amount + billFee(b)
      if (accIdOf(b, 'to', ix) === accId) v += b.amount
    } else if (b.type === 'debt') {
      // 资金账户一侧：借入 / 收款（扣手续费后到账）进钱，借出 / 还款（手续费另付）出钱
      if (b.catId === 'borrow' && from === accId) v += b.amount
      if (b.catId === 'lend' && from === accId) v -= b.amount
      if (b.catId === 'repay' && from === accId) v -= b.amount + billFee(b)
      if (b.catId === 'collect' && from === accId) v += b.amount - billFee(b)
    }
    // 记账页「债务」选了具体债务账户：借入 → 应付款多欠（余额更负），借出 → 应收款多收（余额更正）。
    // 只认 debtLink 标记；债务账户「生成账单」产生的账单金额已在账户初始余额里，不能再算一次。
    // 债务账户一侧：借入 → 应付款更负、还款 → 应付款回升；借出 → 应收款更正、收款 → 应收款回落。
    if (b.type === 'debt' && b.debtLink && b.debtAccountId === accId) {
      v += (b.catId === 'borrow' || b.catId === 'collect') ? -b.amount : b.amount
    }
    // 退款回补：退款金额转入退款账户（与原支出同账户时，表现为直接减少支出）
    if (b.type === 'expense' && Array.isArray(b.refunds)) {
      b.refunds.forEach(rf => {
        if (accIdOf({ accountId: rf.accountId, account: rf.account }, 'from', ix) === accId) {
          v += Number(rf.amount) || 0
        }
      })
    }
  })
  return Math.round(v * 100) / 100
}

// 资产总览（会计恒等式：净资产 = 总资产 − 总负债）
//   · 总资产 = 普通账户余额 + 应收；总负债 = 信用账户欠款 + 应付；净资产 = 总资产 − 总负债。
//   · 借入 / 借出本身不改变净资产：借入 = 现金 + 应付 +，借出 = 现金 − 应收 +；
//     只有手续费这类真实流出才会减少净资产。
// 应收 / 应付 = 应收款 / 应付款账户的待收 / 待还（debtPending，与债务列表页同一口径）
//   + 没挂在任何债务账户上的老借入 / 借出账单。记到具体债务账户的账单已在账户余额里；
//   债务账户「生成账单」产生的账单（带 debtAccountId、不带 debtLink）金额在账户初始余额里，都不能再算一次。
function getAssetSummary() {
  const bills = getBillsSync()
  const idx = accountIndex()
  let assets = 0, liability = 0, receivable = 0, payable = 0
  getAccounts(false).forEach(a => {
    if (a.inTotal === false) return // 账户编辑页「计入总资产」关闭：不进总资产/总负债/净资产/应收应付
    const bal = accountBalance(a.id, bills, idx)
    if (kinds.groupOf(a) === 'debt') {
      // 报销账户不属于应收应付（待报销单独统计）
      if (a.kind === 'receivable') receivable += debtPending(a, bal)
      else if (a.kind === 'payable') payable += debtPending(a, bal)
    } else if (a.type === 'credit') liability += Math.max(0, -bal)
    else assets += bal
  })
  let reimburse = 0
  bills.forEach(b => {
    if (b.type === 'debt' && !b.debtAccountId && (b.catId === 'lend' || b.catId === 'borrow')) {
      if (b.catId === 'lend') receivable += b.amount
      else payable += b.amount
    }
    // 待报销：按账单关联的报销账户归集，扣除已退款（已报销）部分
    if (b.type === 'expense' && b.reimburse && !b.reimburseDone && reimburseAccIdOf(b)) {
      reimburse += effectiveExpense(b)
    }
  })
  const r2 = v => Math.round(v * 100) / 100
  const totalAssets = r2(assets + receivable)
  const totalLiability = r2(liability + payable)
  return {
    assets: totalAssets,
    liability: totalLiability,
    net: r2(totalAssets - totalLiability),
    receivable: r2(receivable), payable: r2(payable), reimburse: r2(reimburse)
  }
}

// 这笔债务账单是否直接调整应收 / 应付：记到具体债务账户上的（debtLink），
// 或没挂债务账户的老借入 / 借出——与 getAssetSummary 的统计口径一致
function adjustsDebt(b) {
  if (b.type !== 'debt') return false
  return !!b.debtLink || (!b.debtAccountId && (b.catId === 'lend' || b.catId === 'borrow'))
}

// 一笔账单对净资产的影响（统计页资产走势倒推用）：收入 +、支出 −；转账只有手续费是流出；
// 债务 = 资金账户的现金变动 + 应收 / 应付的变动：借入 现金 +金额、应付 +金额（净 0），
// 借出 现金 −金额、应收 +金额（净 0），还款 / 收款只剩手续费的流出；
// 没选资金账户（只记债务）时只有债务一侧，净资产随之变化
function netEffect(b) {
  if (b.type === 'transfer') return -billFee(b)
  if (b.type === 'income') return billAmount(b)
  if (b.type === 'expense') return -billAmount(b)
  if (b.type !== 'debt') return 0
  const amt = Number(b.amount) || 0
  let v = 0
  if (accIdOf(b, 'from')) {
    if (b.catId === 'borrow') v += amt
    else if (b.catId === 'lend') v -= amt
    else if (b.catId === 'repay') v -= amt + billFee(b)
    else if (b.catId === 'collect') v += amt - billFee(b)
  }
  if (adjustsDebt(b)) v += (b.catId === 'borrow' || b.catId === 'collect') ? -amt : amt
  return v
}

// 是否为报销账户（债务分组 · reimburse 品类）
function isReimburseAccount(id) {
  const a = getAccount(id)
  return !!a && kinds.groupOf(a) === 'debt' && a.kind === 'reimburse'
}

// 可报销账单归集到的报销账户 id：优先账单上的 reimburseAccountId；
// 旧数据没有该字段时，若付款账户本身是报销账户则用它，否则无法归集
function reimburseAccIdOf(b) {
  if (b.reimburseAccountId) {
    const direct = getAccount(b.reimburseAccountId)
    if (direct) return direct.id
    const byName = getAccounts(true).find(a => a.name === b.reimburseAccount)
    if (byName) return byName.id
  }
  const fromId = accIdOf(b, 'from')
  return isReimburseAccount(fromId) ? fromId : null
}

// 应付款 / 应收款账户的待还 / 待收金额：应付款余额为负（欠款）、应收款为正（债权），
// 反向（多还了 / 多收了）不算反向债务，按 0 计——汇总、债务列表、记账页债务选择器共用这一口径
function debtPending(acc, balance) {
  const v = acc.kind === 'payable' ? -balance : balance
  return v > 0 ? Math.round(v * 100) / 100 : 0
}

// 归集到某个报销账户的可报销账单（支出 + 勾了「可报销」+ 关联该账户），含已报销 / 已结束的。
// 注意：这些账单的付款账户是别的资金账户（如网商银行），所以不能用 accountBills（按付款 / 转入账户找）来查；
// 报销账户详情页、报销账户列表、资产页「待报销」都按同一个口径（reimburseAccIdOf）归集
function reimburseBills(accId, bills) {
  return (bills || getBillsSync()).filter(b =>
    b.type === 'expense' && b.reimburse && reimburseAccIdOf(b) === accId)
}

// 一笔可报销账单的金额口径：
//   pending  待报销 = 金额 − 已退回（商家退款 + 报销到账）；已结束报销的账单不再待报销
//   done     已报销 = 报销到账记录合计（商家退款不算「已报销」）
function reimburseAmounts(b) {
  const amt = Number(b.amount) || 0
  const rt = Math.min(refundTotal(b), amt)
  return {
    pending: b.reimburseDone ? 0 : Math.max(amt - rt, 0),
    done: Math.min(reimbursedTotal(b), amt)
  }
}

// 报销账户汇总（详情页绿色汇总卡）：待报销 / 已报销 / 总报销（= 待报销 + 已报销）
function reimburseSummary(accId, bills) {
  let pending = 0, done = 0
  reimburseBills(accId, bills).forEach(b => {
    const a = reimburseAmounts(b)
    pending += a.pending
    done += a.done
  })
  const r = v => Math.round(v * 100) / 100
  return { pending: r(pending), done: r(done), total: r(pending + done) }
}

// 债务分组某品类的账户视图（debt-list 页用）：pending=待处理金额，done=已处理金额
function getDebtViews(kind) {
  const bills = getBillsSync()
  const idx = accountIndex()
  return getAccounts(false)
    .filter(a => kinds.groupOf(a) === 'debt' && a.kind === kind)
    .map(a => {
      let pending = 0
      let done = 0
      if (kind === 'reimburse') {
        const sum = reimburseSummary(a.id, bills)
        pending = sum.pending
        done = sum.done
      } else {
        pending = debtPending(a, accountBalance(a.id, bills, idx))
      }
      return { id: a.id, name: a.name, icon: a.icon, pending, done }
    })
}

function debtSummary(kind) {
  return getDebtViews(kind).reduce((s, v) => ({
    pending: s.pending + v.pending, done: s.done + v.done
  }), { pending: 0, done: 0 })
}

// 应付款 / 应收款账户详情页汇总卡（报销账户不适用，返回 null）：
//   pending  待还 / 待收（debtPending 口径）；done  已还 / 已收（记在该账户名下的还款 / 收款账单金额合计）；
//   interest 已还 / 已收利息（还款 / 收款账单的 interest 字段合计，目前记账页还没有利息输入，恒为 0）；
//   nextDue  下次还 / 收款日：各笔借入 / 借出账单（含新增账户时生成的初始账单）的 repayDate 里，今天及以后最早的一天；
//            都已过期则取最近的一天并标 overdue；全部还清（pending=0）或没设置则为空
function debtDetail(accId) {
  const acc = getAccount(accId)
  if (!acc || kinds.groupOf(acc) !== 'debt' || (acc.kind !== 'payable' && acc.kind !== 'receivable')) return null
  const bills = getBillsSync()
  const payable = acc.kind === 'payable'
  const settleCat = payable ? 'repay' : 'collect'
  const addCat = payable ? 'borrow' : 'lend'
  let done = 0, interest = 0
  const dues = []
  bills.forEach(b => {
    if (b.type !== 'debt' || b.debtAccountId !== accId) return
    if (b.catId === settleCat) {
      done += Number(b.amount) || 0
      interest += Number(b.interest) || 0
    } else if (b.catId === addCat && b.repayDate) dues.push(b.repayDate)
  })
  const pending = debtPending(acc, accountBalance(accId, bills))
  const today = util.dateStr()
  dues.sort()
  const upcoming = dues.filter(d => d >= today)[0]
  const nextDue = pending > 0 ? (upcoming || dues[dues.length - 1] || '') : ''
  const r2 = v => Math.round(v * 100) / 100
  return {
    kind: acc.kind, pending, done: r2(done), interest: r2(interest),
    nextDue, overdue: !!nextDue && nextDue < today
  }
}

// ------------------------------------------------------------- 信贷账户
// 信贷账户（信贷分组）在账户上多存：limit 总额度、shareWith 共享额度的账户 id（空 = 不共享）、
// billDay / repayDay 每月出账日 / 还款日（0 = 未设置）、nextPeriod 出账日消费是否计入下一期、
// annualFee { amount, date } 年费金额与首次扣费日（空 = 无年费）。余额为负 = 欠款，为正 = 溢缴（多还的存款）。
function isCreditAccount(a) {
  return !!a && kinds.groupOf(a) === 'credit'
}

// 信贷账户的额度视图。共享额度的账户用被共享账户的总额度，已用额度 = 共享组内所有账户的欠款合计；
// limit 为 0 表示没设置额度（remaining / pct 没有意义）
function creditInfo(accId, bills) {
  bills = bills || getBillsSync()
  const acc = getAccount(accId)
  const host = (acc.shareWith && getAccount(acc.shareWith)) || acc
  const limit = Number(host.limit) || 0
  const idx = accountIndex()
  const owedOf = a => Math.max(0, -accountBalance(a.id, bills, idx))
  const used = getAccounts(true)
    .filter(a => isCreditAccount(a) && (a.id === host.id || a.shareWith === host.id))
    .reduce((sum, a) => sum + owedOf(a), 0)
  const bal = accountBalance(accId, bills, idx)
  const r2 = v => Math.round(v * 100) / 100
  return {
    owed: r2(Math.max(0, -bal)), surplus: r2(Math.max(0, bal)),
    limit, used: r2(used), remaining: r2(Math.max(0, limit - used)),
    pct: limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0,
    shared: host.id !== acc.id,
    billDay: acc.billDay || 0, repayDay: acc.repayDay || 0
  }
}

// 账户详情页「统计」：本月 / 本年 / 累计的 消费（支出）、还款 / 转入（转入 + 收入）、转出（含手续费）
function accountStats(accId) {
  const today = util.dateStr()
  const ranges = { month: today.slice(0, 7), year: today.slice(0, 4), all: '' }
  const out = {}
  const idx = accountIndex()
  Object.keys(ranges).forEach(k => { out[k] = { spend: 0, repay: 0, out: 0 } })
  accountBills(accId).forEach(b => {
    let key, amt
    if (b.type === 'expense') { key = 'spend'; amt = effectiveExpense(b) }
    else if (b.type === 'income') { key = 'repay'; amt = Number(b.amount) || 0 }
    else if (b.type === 'transfer' && accIdOf(b, 'to', idx) === accId) { key = 'repay'; amt = b.amount }
    else if (b.type === 'transfer') { key = 'out'; amt = b.amount + billFee(b) }
    else return
    Object.keys(ranges).forEach(k => { if (b.date.indexOf(ranges[k]) === 0) out[k][key] += amt })
  })
  Object.keys(out).forEach(k => Object.keys(out[k]).forEach(f => { out[k][f] = Math.round(out[k][f] * 100) / 100 }))
  return out
}

// 年费：信贷账户设置了年费（金额 + 首次扣费日）后，从扣费日起每年同一天自动记一笔支出（其他 / 备注「年费」）。
// 账单 id 固定为 fee-账户id-年份：已经记过、或被用户删掉（墓碑）的年份不会重记，多设备同时补记也只会合并成一笔
// 年费日落到某一年的实际日期：2 月 29 日在平年顺延不出界，取当月最后一天（避免生成 2025-02-29 这种不存在的日期）
function feeDateInYear(feeDate, y) {
  const m = Number(feeDate.slice(5, 7))
  const d = Number(feeDate.slice(8, 10))
  const last = new Date(y, m, 0).getDate()
  return y + '-' + feeDate.slice(5, 7) + '-' + String(Math.min(d, last)).padStart(2, '0')
}

function postAnnualFees() {
  const today = util.dateStr()
  const bills = getBillsSync()
  const tombs = getTombs()
  getAccounts(true).forEach(a => {
    const fee = a.annualFee
    if (!isCreditAccount(a) || !fee || !(fee.amount > 0)) return
    // 年费设置随账户云同步而来：日期缺失 / 格式不对时整条跳过（否则缺字段会在 onLaunch 里直接抛错，空串会从公元 0 年一路补记）
    if (typeof fee.date !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(fee.date)) return
    for (let y = Number(fee.date.slice(0, 4)); y <= Number(today.slice(0, 4)); y++) {
      const id = 'fee-' + a.id + '-' + y
      const date = feeDateInYear(fee.date, y)
      if (date > today || tombs[id] || bills.some(b => b.id === id)) continue
      addBill({ id, type: 'expense', catId: 'other', sub: '', amount: fee.amount, date, accountId: a.id, account: a.name, remark: '年费' })
    }
  })
}

// 账户列表（带余额）
function getAccountViews() {
  const bills = getBillsSync()
  const idx = accountIndex()
  return getAccounts(false).map(a => ({
    id: a.id, name: a.name, type: a.type, group: kinds.groupOf(a), icon: a.icon,
    balance: accountBalance(a.id, bills, idx),
    // 在存定存本金 / 可用余额（账户页卡片显示可用余额，定存另起一行灰字）
    held: depositHeld(a.id),
    available: availableBalance(a.id, bills, '', idx)
  }))
}

// 某账户相关账单
function accountBills(accId) {
  const idx = accountIndex()
  return getBillsSync().filter(b =>
    accIdOf(b, 'from', idx) === accId || accIdOf(b, 'to', idx) === accId ||
    (b.type === 'debt' && b.debtLink && b.debtAccountId === accId)) // 债务账户也能看到记在它名下的借入 / 借出
}

// ------------------------------------------------------------- 定期存款
// 定存是「记录」不是账户。存入时本金不另记账单，而是从所选「存入账户」的可用余额里扣除：
//   可用余额 = 账户账本余额（accountBalance）− 该账户在存（未到期、未提前支取）的定存本金（depositHeld）。
// 到期 / 提前支取 / 删除后本金自然回到可用余额，不需要再记转账；账本余额与总资产不变（本金仍是资产）。
// 收益：到期当天自动记一笔「投资理财 · 利息」收入（postDepositIncome）；提前支取时由用户手动填写已得收益（withdrawDeposit）。
// 纯计算见 utils/deposit.js。记录随账户 / 预算一起云同步（getMeta / applyMeta），所以写入后走 touchMeta。
//   定存记录附加字段：withdrawn(已提前支取)、withdrawDate、withdrawInterest(实际收益)
function getDeposits(accountId) {
  const list = wx.getStorageSync(K_DEPOSITS) || []
  return accountId ? list.filter(d => d.accountId === accountId) : list
}

function getDeposit(id) {
  return getDeposits().find(d => d.id === id)
}

// 在存：还没到期、也没提前支取（占用存入账户的可用余额）
function isDepositActive(d, today) {
  return !d.withdrawn && d.maturityDate > (today || util.dateStr())
}

// 某账户被在存定存占用的本金；excludeId 用于编辑某笔定存时把它自己排除
function depositHeld(accId, excludeId) {
  if (!accId) return 0
  const today = util.dateStr()
  let sum = 0
  getDeposits(accId).forEach(d => {
    if (d.id !== excludeId && isDepositActive(d, today)) sum += Number(d.amount) || 0
  })
  return Math.round(sum * 100) / 100
}

// 账户可用余额（账本余额 − 在存定存本金）
function availableBalance(accId, bills, excludeId, idx) {
  return Math.round((accountBalance(accId, bills, idx) - depositHeld(accId, excludeId)) * 100) / 100
}

// 存入前校验：可用余额为负或小于存入金额 → 不能存入
function checkDepositFunds(accId, amount, excludeId) {
  const available = availableBalance(accId, null, excludeId)
  return { ok: available > 0 && available >= amount, available }
}

// 新增（无 id）或更新（有 id）；返回保存后的记录
function saveDeposit(data) {
  const list = getDeposits()
  const now = Date.now()
  let saved
  if (data.id) {
    const i = list.findIndex(d => d.id === data.id)
    if (i < 0) return null
    saved = list[i] = Object.assign(list[i], data, { updateTime: now })
  } else {
    saved = Object.assign({ billed: false }, data, { id: util.genId(), createTime: now, updateTime: now })
    list.push(saved)
  }
  put(K_DEPOSITS, list)
  touchMeta()
  return saved
}

function removeDeposit(id) {
  put(K_DEPOSITS, getDeposits().filter(d => d.id !== id))
  touchMeta()
}

// 定期存款汇总（账户页「定期存款」卡片 / 定存记录页顶部）：只统计在存的；accountId 为空 = 全部账户
//   principal 在存本金；income 预计收益；count 笔数
function depositSummary(accountId) {
  const today = util.dateStr()
  const r2 = v => Math.round(v * 100) / 100
  let principal = 0, income = 0, count = 0
  getDeposits(accountId).forEach(d => {
    if (!isDepositActive(d, today)) return
    principal += Number(d.amount) || 0
    income += Number(d.income) || 0
    count++
  })
  return { principal: r2(principal), income: r2(income), count }
}

// 到期自动记收益：存期结束当天（含补开已过期的）记一笔「投资理财 · 利息」收入，记到定存上选的存入账户（没选则不动任何账户余额）。
// 账单 id 固定为 dep-定存id：记过、或被用户删掉（墓碑）的不会重记，多设备同时补记也只会合并成一笔。
// 已记过的定存打上 billed，之后不再检查；已提前支取的定存收益在支取时已处理，这里跳过。启动 / 回到账户页 / 保存定存后调用。
function postDepositIncome() {
  const today = util.dateStr()
  const list = getDeposits()
  let changed = false
  list.forEach(d => {
    if (d.billed || d.withdrawn || !d.maturityDate || d.maturityDate > today) return
    const id = 'dep-' + d.id
    const income = Number(d.income) || 0
    if (income > 0 && !getTombs()[id] && !getBill(id)) {
      const acc = d.accountId && getAccount(d.accountId)
      addBill({
        id, type: 'income', catId: 'invest', sub: '利息', amount: income, date: d.maturityDate,
        accountId: acc ? acc.id : '', account: acc ? acc.name : '', toAccountId: '', toAccount: '',
        remark: '定期存款到期收益' + (d.remark ? '：' + d.remark : '')
      })
    }
    d.billed = true
    changed = true
  })
  if (!changed) return false
  put(K_DEPOSITS, list)
  touchMeta()
  return true
}

// 提前支取：本金立即回到存入账户的可用余额，用户手动填写的已得收益（可为 0）记一笔「投资理财 · 利息」收入（今天，记到存入账户）。
// 之后这笔定存不再计入在存、也不再生成到期收益。返回 { ok, billed }；已支取 / 已到期 / 不存在的返回 ok:false
function withdrawDeposit(id, interest) {
  const list = getDeposits()
  const d = list.find(x => x.id === id)
  const today = util.dateStr()
  if (!d || !isDepositActive(d, today)) return { ok: false, billed: false }
  const gain = Math.round((Number(interest) || 0) * 100) / 100
  let billed = false
  if (gain > 0) {
    const acc = d.accountId && getAccount(d.accountId)
    addBill({
      id: 'dep-' + d.id, type: 'income', catId: 'invest', sub: '利息', amount: gain, date: today,
      accountId: acc ? acc.id : '', account: acc ? acc.name : '', toAccountId: '', toAccount: '',
      remark: '定期存款提前支取收益' + (d.remark ? '：' + d.remark : '')
    })
    billed = true
  }
  Object.assign(d, { withdrawn: true, withdrawDate: today, withdrawInterest: gain, billed: true, updateTime: Date.now() })
  put(K_DEPOSITS, list)
  touchMeta()
  return { ok: true, billed }
}

// ------------------------------------------------------------- 预算
function getBudgetMap() {
  return wx.getStorageSync(K_BUDGET) || {}
}

// 原始预算（用户设定值）
function getBudget(ym) {
  const m = getBudgetMap()
  return m[ym] != null ? m[ym] : (m['default'] != null ? m['default'] : 0)
}

// “每月预算”：不针对具体某月，对所有未单独设置的月份生效
function getMonthlyDefault() {
  const m = getBudgetMap()
  return m['default'] != null ? m['default'] : 0
}
function setMonthlyDefault(value) {
  const m = getBudgetMap()
  m['default'] = Number(value) || 0
  put(K_BUDGET, m)
  touchMeta()
}

// 单独设置／取消某个具体月份的预算，不影响每月预算（默认值）
function setMonthOverride(ym, value) {
  const m = getBudgetMap()
  m[ym] = Number(value) || 0
  put(K_BUDGET, m)
  touchMeta()
}
function clearMonthOverride(ym) {
  const m = getBudgetMap()
  delete m[ym]
  put(K_BUDGET, m)
  touchMeta()
}
function hasMonthOverride(ym) {
  return getBudgetMap()[ym] != null
}

function getBudgetConf() {
  return Object.assign({}, DEFAULT_BUDGET_CONF, wx.getStorageSync(K_BUDGET_CONF) || {})
}

function setBudgetConf(patch) {
  put(K_BUDGET_CONF, Object.assign(getBudgetConf(), patch))
  touchMeta()
}

function shiftYM(ym, delta) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return util.monthKey(d.getFullYear(), d.getMonth() + 1)
}

// ------------------------------------------------------------- 预算：特定周期（自定义起止日期）
function getBudgetPeriods() {
  return wx.getStorageSync(K_BUDGET_PERIODS) || []
}

function getBudgetPeriod(id) {
  return getBudgetPeriods().find(p => p.id === id) || null
}

function addBudgetPeriod(p) {
  const list = getBudgetPeriods()
  const item = {
    id: util.genId(),
    name: (p.name || '').trim() || '周期预算',
    start: p.start,
    end: p.end,
    amount: Number(p.amount) || 0
  }
  list.push(item)
  put(K_BUDGET_PERIODS, list)
  touchMeta()
  return item
}

function updateBudgetPeriod(id, patch) {
  const list = getBudgetPeriods()
  const i = list.findIndex(p => p.id === id)
  if (i < 0) return null
  list[i] = Object.assign({}, list[i], patch)
  put(K_BUDGET_PERIODS, list)
  touchMeta()
  return list[i]
}

function removeBudgetPeriod(id) {
  put(K_BUDGET_PERIODS, getBudgetPeriods().filter(p => p.id !== id))
  touchMeta()
}

// 某个闭区间 [start, end]（YYYY-MM-DD）内的全部支出
function periodExpense(start, end) {
  let sum = 0
  getBillsSync().forEach(b => {
    if (b.type === 'expense' && typeof b.date === 'string' && b.date >= start && b.date <= end) sum += budgetExpense(b)
  })
  return Math.round(sum * 100) / 100
}

// 生效预算（含上月结转 / 超额扣除）
function getBudgetEffective(ym) {
  const base = getBudget(ym)
  const conf = getBudgetConf()
  let v = base
  const last = shiftYM(ym, -1)
  let lastExpense = 0
  monthBills(last).forEach(b => { if (b.type === 'expense') lastExpense += budgetExpense(b) })
  const lastLeft = getBudget(last) - lastExpense
  if (conf.carry && lastLeft > 0) v += lastLeft
  if (conf.overcut && lastLeft < 0) v += lastLeft
  return Math.round(v * 100) / 100
}

// ------------------------------------------------------------- 卡片 / 视图
function getCardConfig() {
  return Object.assign({}, DEFAULT_CARD, wx.getStorageSync(K_CARD) || {})
}

function setCardConfig(cfg) {
  put(K_CARD, cfg)
  touchMeta() // 首页卡片配置随账户 / 预算同步到其它设备
}

function getViewMode() {
  return wx.getStorageSync(K_VIEW) || 'detail'
}

function setViewMode(mode) {
  put(K_VIEW, mode)
}

function getTimeRange() {
  return wx.getStorageSync(K_RANGE) || 'all'
}

function setTimeRange(range) {
  put(K_RANGE, range)
}

// ------------------------------------------------------------- 分类设置
// 记账页的一级分类 / 子分类由用户自行编辑（隐藏、新增、改名换图标、排序），全部收在 cat_prefs 一份里，
// 按类型（expense / income / transfer / debt）分开存放——支出与收入都有 id='other'，不能混用：
//   { [type]: { hidden: [catId], order: [catId], custom: [{ id, label, icon }],
//               edits: { [catId]: { label?, icon? } }, subs: { [catId]: [子分类名] } } }
// 每次修改都 touchMeta，随账户 / 预算同步到云端。
function getCatPrefs(type) {
  const p = (wx.getStorageSync(K_CAT_PREFS) || {})[type] || {}
  return { hidden: p.hidden || [], order: p.order || [], custom: p.custom || [], edits: p.edits || {}, subs: p.subs || {} }
}

function setCatPrefs(type, patch) {
  const all = wx.getStorageSync(K_CAT_PREFS) || {}
  all[type] = Object.assign(getCatPrefs(type), patch)
  put(K_CAT_PREFS, all)
  touchMeta()
}

function without(obj, key) {
  const o = Object.assign({}, obj)
  delete o[key]
  return o
}

// 内置 + 自定义的全部一级分类（带用户改名 / 换图标；未排序、不过滤隐藏）
function allCats(type) {
  const p = getCatPrefs(type)
  return cats.getCats(type).concat(p.custom).map(c => Object.assign({}, c, p.edits[c.id]))
}

// 按 id 取一级分类（含自定义与改名）；type 已知时只在该类型里找
function getCat(id, type) {
  return allCats(type).find(c => c.id === id) || cats.getCat(id)
}

// 当前可选的一级分类：去掉隐藏的，按用户排序（排序里没有的新分类排在最后）；全部被隐藏时兜底显示全部
function visibleCats(type) {
  const p = getCatPrefs(type)
  const all = allCats(type)
  const rank = id => { const i = p.order.indexOf(id); return i < 0 ? p.order.length : i }
  const list = all.filter(c => p.hidden.indexOf(c.id) < 0).sort((a, b) => rank(a.id) - rank(b.id))
  return list.length ? list : all
}

function saveCatOrder(type, ids) {
  setCatPrefs(type, { order: ids })
}

function addCustomCat(type, label, icon) {
  const id = 'c_' + Date.now()
  setCatPrefs(type, { custom: getCatPrefs(type).custom.concat({ id, label, icon }) })
  return id
}

// edit = { label, icon }（内置与自定义分类统一用覆盖表，账单里存的是 catId，改名后历史账单跟着变）
function updateCat(type, catId, edit) {
  setCatPrefs(type, { edits: Object.assign({}, getCatPrefs(type).edits, { [catId]: edit }) })
}

// 删除一级分类：自定义的整条移除，内置的只是隐藏（「分类管理」页可恢复）
function removeCat(type, catId) {
  const p = getCatPrefs(type)
  if (p.custom.some(c => c.id === catId)) {
    setCatPrefs(type, {
      custom: p.custom.filter(c => c.id !== catId),
      order: p.order.filter(id => id !== catId),
      edits: without(p.edits, catId),
      subs: without(p.subs, catId)
    })
  } else {
    setCatPrefs(type, { hidden: p.hidden.concat(catId) })
  }
}

function getHiddenCats(type) {
  return getCatPrefs(type).hidden
}

function setCatHidden(type, catId, hidden) {
  const rest = getHiddenCats(type).filter(id => id !== catId)
  setCatPrefs(type, { hidden: hidden ? rest.concat(catId) : rest })
}

function clearHiddenCats() {
  ;['expense', 'income'].forEach(type => setCatPrefs(type, { hidden: [] }))
}

// 某一级分类下的子分类（记账页与 AI 识别共用）：用户编辑过就用编辑后的整份，否则用内置
function subsOf(type, catId) {
  return getCatPrefs(type).subs[catId] || (getCat(catId, type) || {}).subs || []
}

function saveSubs(type, catId, list) {
  setCatPrefs(type, { subs: Object.assign({}, getCatPrefs(type).subs, { [catId]: list }) })
}

// 当前用户可用的分类树 { type: { catId: { label, subs: [子分类…] } } }。AI 识别只允许在这棵树里选，
// 这样云函数不需要自带一份分类表（不会与小程序漂移），自定义 / 改名 / 隐藏的分类自然生效
function categoryTree() {
  const tree = {}
  cats.TYPES.forEach(t => {
    tree[t.key] = {}
    visibleCats(t.key).forEach(c => { tree[t.key][c.id] = { label: c.label, subs: subsOf(t.key, c.id) } })
  })
  return tree
}

// 旧版把分类设置拆在 4 个 key 里，且按分类 id 存（支出 / 收入的 'other' 会串）。
// 升级后首次启动并入 cat_prefs 并删掉旧 key；旧的子分类是「自定义的排在内置前面」，这里展开成完整列表
const LEGACY_CAT_KEYS = ['hidden_cats', 'custom_cats', 'cat_order', 'custom_subs']

function migrateCatPrefs() {
  const stored = wx.getStorageInfoSync().keys
  if (!LEGACY_CAT_KEYS.some(k => stored.indexOf(k) >= 0)) return
  const [hidden, custom, order, subs] = LEGACY_CAT_KEYS.map(k => wx.getStorageSync(k) || (k === 'hidden_cats' ? [] : {}))
  const prefs = {}
  cats.TYPES.forEach(({ key }) => {
    const mine = custom[key] || []
    const own = cats.getCats(key).concat(mine)
    const full = {}
    own.forEach(c => { if ((subs[c.id] || []).length) full[c.id] = subs[c.id].concat(c.subs || []) })
    prefs[key] = {
      hidden: hidden.filter(id => own.some(c => c.id === id)),
      order: order[key] || [],
      custom: mine.map(c => ({ id: c.id, label: c.label, icon: c.icon })),
      subs: full
    }
  })
  put(K_CAT_PREFS, prefs)
  LEGACY_CAT_KEYS.forEach(k => drop(k))
}

// ------------------------------------------------------------- 默认账户
// 上次手动选择的收支账户（记账页与 AI 记账共用）。accounts 为当前场景允许选的账户，
// 上次的账户已删除 / 不在其中时视为没有
function lastAccountId(accounts) {
  const id = wx.getStorageSync(K_LAST_ACC)
  return accounts.some(a => a.id === id) ? id : ''
}

function setLastAccountId(id) {
  put(K_LAST_ACC, id)
}

// ------------------------------------------------------------- 模板
function getTemplates() {
  return wx.getStorageSync(K_TPL) || []
}

function addTemplate(data) {
  const list = getTemplates()
  const tpl = Object.assign({ id: util.genId(), name: data.name || '常用模板' }, data)
  list.push(tpl)
  put(K_TPL, list)
  touchMeta() // 模板随账户 / 预算同步到其它设备
  return tpl
}

function removeTemplate(id) {
  put(K_TPL, getTemplates().filter(t => t.id !== id))
  touchMeta()
}

// ------------------------------------------------------------- 标签
function tagStats() {
  const map = {}
  getBillsSync().forEach(b => {
    if (!b.tag) return
    if (!map[b.tag]) map[b.tag] = { tag: b.tag, count: 0, expense: 0, income: 0 }
    map[b.tag].count++
    if (b.noCount) return // 不计入收支的账单不进标签金额汇总（笔数仍计）
    const ft = flowType(b)
    if (ft === 'expense') map[b.tag].expense += b.amount
    if (ft === 'income') map[b.tag].income += b.amount
  })
  return Object.values(map).sort((a, b) => b.count - a.count)
}

function retag(from, to) {
  const list = getBillsSync()
  const now = Date.now()
  list.forEach(b => { if (b.tag === from) { b.tag = to; b.updateTime = now; pushBill(b) } })
  writeAll(list)
}

function renameTag(oldTag, newTag) {
  if (!newTag || oldTag === newTag) return
  retag(oldTag, newTag)
}

function deleteTag(tag) {
  retag(tag, '')
}

// ------------------------------------------------------------- 用户
// 默认头像与随机昵称：登录后用户没有自己设置头像/昵称时兜底
const DEFAULT_AVATAR = '/images/ui/default_avatar.png'
const NICK_ADJ = ['勤俭', '快乐', '机灵', '佛系', '元气', '悠闲', '靠谱', '知足', '乐观', '精明']
const NICK_NOUN = ['松鼠', '小熊', '柴犬', '橘猫', '企鹅', '海豚', '兔子', '仓鼠', '海獭', '考拉']

// 随机昵称，形如「元气橘猫3827」；生成后会持久化，之后不会再变
function randomNick() {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)]
  return pick(NICK_ADJ) + pick(NICK_NOUN) + (1000 + Math.floor(Math.random() * 9000))
}

function getUser() {
  return Object.assign({ avatar: '', nick: '' }, wx.getStorageSync(K_USER) || {})
}

function setUser(patch) {
  const u = Object.assign(getUser(), patch)
  put(K_USER, u)
  return u
}

// 头像 / 昵称缺失时补默认值并持久化（已设置的不会被覆盖）
function ensureUserProfile() {
  const u = getUser()
  const patch = {}
  if (!u.avatar) patch.avatar = DEFAULT_AVATAR
  if (!String(u.nick || '').trim()) patch.nick = randomNick()
  return Object.keys(patch).length ? setUser(patch) : u
}

// chooseAvatar 返回的是临时文件，重启后会失效；存入本地永久目录后再保存，失败则退回原路径
function saveAvatar(tempPath) {
  return new Promise(resolve => {
    if (!tempPath || tempPath.indexOf('/images/') === 0 || !wx.saveFile) { resolve(tempPath); return }
    wx.saveFile({
      tempFilePath: tempPath,
      success: r => resolve(r.savedFilePath),
      fail: () => resolve(tempPath)
    })
  })
}

function userStats() {
  const bills = getBillsSync()
  let days = 0
  if (bills.length) {
    const first = bills.map(b => b.date).sort()[0]
    days = Math.floor((Date.now() - util.parseDate(first).getTime()) / 86400000) + 1
  }
  return { days, count: bills.length }
}

// ------------------------------------------------------------- 统计
// 支出账单的累计退款额 / 实际支出额（退款直接减少支出，不另记收入）
function refundTotal(b) {
  return (b.refunds || []).reduce((s, r) => s + (Number(r.amount) || 0), 0)
}
function effectiveExpense(b) {
  return Math.max(0, (Number(b.amount) || 0) - refundTotal(b))
}
// 一笔账单计入统计的金额：支出扣除退款，其它类型即原金额。
// 任何页面做收支汇总都应经由它（或 store 里的汇总函数），不要直接读 b.amount，否则会漏掉退款
// 统计口径（账单属性）：
//   noCount  不计入收支：账户余额照常变动，但不进任何收入 / 支出统计，也不占预算
//   noBudget 不计入预算：照常计入支出统计，只是不占用预算额度
function statExpense(b) {
  return b.noCount ? 0 : effectiveExpense(b)
}
function statIncome(b) {
  return b.noCount ? 0 : (Number(b.amount) || 0)
}
function budgetExpense(b) {
  return (b.noCount || b.noBudget || b.reimburse) ? 0 : effectiveExpense(b)
}
// 这笔账单在收入 / 支出汇总里算哪一边：'income' | 'expense' | ''（不进收支汇总）。
//   收入 / 支出账单：就是自己的类型（是否计入由 statIncome / statExpense 的 noCount 处理）。
//   债务账单：记账页勾选「生成账单」= 计入收支（noCount 为 false）——
//     借入 / 收款（钱流入）→ 收入；借出 / 还款（钱流出）→ 支出。
//     没勾选（noCount 为 true，只调整债务账户余额）的不进汇总。转账永远不进。
//   每日 / 每月 / 年度 / 日历 / 统计 / 标签等所有收支汇总都用它判断，不要直接比较 b.type。
function flowType(b) {
  if (b.type === 'income' || b.type === 'expense') return b.type
  if (b.type !== 'debt' || b.noCount) return ''
  if (b.catId === 'borrow' || b.catId === 'collect') return 'income'
  if (b.catId === 'lend' || b.catId === 'repay') return 'expense'
  return ''
}
function billAmount(b) {
  if (b.type === 'expense') return statExpense(b)
  if (b.type === 'income') return statIncome(b)
  return b.amount
}

// 撤销（删除）一笔退款记录，账单支出自动恢复
function removeRefund(billId, refundId) {
  const b = getBill(billId)
  if (!b || !b.refunds) return false
  const next = b.refunds.filter(r => r.id !== refundId)
  if (next.length === b.refunds.length) return false
  updateBill(billId, { refunds: next })
  return true
}

// 修改一笔退款记录；返回 '' 成功，否则为错误提示
function updateRefund(billId, refundId, patch) {
  const b = getBill(billId)
  if (!b || !b.refunds) return '记录不存在'
  if (!b.refunds.some(r => r.id === refundId)) return '记录不存在'
  const othersTotal = b.refunds
    .filter(r => r.id !== refundId)
    .reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const amt = Number(patch.amount) || 0
  if (amt <= 0) return '请输入退款金额'
  if (othersTotal + amt > (Number(b.amount) || 0) + 0.001) return '退款总额不能超过原金额'
  const refunds = b.refunds.map(r => r.id === refundId
    ? Object.assign({}, r, {
      amount: Math.round(amt * 100) / 100,
      accountId: patch.accountId, account: patch.account,
      date: patch.date, remark: (patch.remark || '').trim()
    })
    : r)
  updateBill(billId, { refunds })
  return ''
}

function monthBills(ym) {
  return getBillsSync().filter(b => typeof b.date === 'string' && b.date.slice(0, 7) === ym)
}

function getMetrics(ym) {
  const [y, m] = ym.split('-').map(Number)
  const dim = util.daysInMonth(y, m)
  const today = new Date()
  const isCur = today.getFullYear() === y && today.getMonth() + 1 === m
  const elapsed = isCur ? today.getDate() : dim
  const left = dim - elapsed + 1

  const bills = monthBills(ym)
  let income = 0, expense = 0, budgetSpent = 0, count = 0, lastExpense = 0, lastT = -1
  bills.forEach(b => {
    const ft = flowType(b)
    if (ft === 'income') { income += statIncome(b); count++ }
    else if (ft === 'expense') {
      const eff = statExpense(b)
      expense += eff; count++
      // 预算只算支出账单：债务的借出 / 还款不占预算
      if (b.type === 'expense') budgetSpent += budgetExpense(b)
      if (b.createTime > lastT) { lastT = b.createTime; lastExpense = eff }
    }
  })
  const budgetTotal = getBudgetEffective(ym)
  const budgetLeft = budgetTotal - budgetSpent
  return {
    income, expense, budgetSpent,
    balance: income - expense,
    budgetTotal,
    budgetLeft,
    dailyAvg: elapsed ? expense / elapsed : 0,
    dailyBudget: dim ? budgetTotal / dim : 0,
    todayLeft: left > 0 ? budgetLeft / left : budgetLeft,
    count,
    lastExpense
  }
}

// 一段账单（区间 start~end）的汇总口径，统计页汇总卡的六行数据。
// 除日均外都按账单日期归属区间；退款按原账单日期归属，与 effectiveExpense 口径一致（跨期不重复计算）。
// 手续费来自转账 / 债务还款、收款账单的 fee 字段（不计入支出 / 预算，单独一行展示）；
// 还款 / 收款来自债务账单的 repay / collect；退款收入 尚无对应账单字段，恒为 0。
// 本模型退款一律冲减支出、不另记收入，所以「退款支出」= 退款总额。
function periodStats(bills, start, end) {
  let expense = 0, income = 0, transfer = 0, borrow = 0, lend = 0, fee = 0, repay = 0, collect = 0
  let reimburse = 0, reimbursed = 0, refund = 0
  bills.forEach(b => {
    const amt = Number(b.amount) || 0
    const ft = flowType(b)
    if (b.type === 'expense') {
      expense += statExpense(b)
      const rt = Math.min(refundTotal(b), amt)
      refund += rt
      if (b.reimburse) { reimburse += amt; reimbursed += rt }
    } else if (b.type === 'income') {
      income += statIncome(b)
    } else if (b.type === 'transfer') {
      transfer += billAmount(b)
      fee += billFee(b)
    } else if (b.type === 'debt') {
      fee += billFee(b) // 还款 / 收款的手续费（钱真的流出，不受「不计收支」影响）
      if (b.noCount) return // 债务账户未开「生成借入 / 借出账单」时只动账户余额的那笔：不进借入 / 借出 / 还款 / 收款统计
      if (ft === 'income') income += statIncome(b) // 勾选「生成账单」：借入 / 收款计入收入，借出 / 还款计入支出
      else if (ft === 'expense') expense += statExpense(b)
      if (b.catId === 'lend') lend += amt
      else if (b.catId === 'repay') repay += amt
      else if (b.catId === 'collect') collect += amt
      else borrow += amt
    }
  })
  // 日均分母：区间已过的天数（末日未到只算到今天）
  const today = util.dateStr()
  const passed = Math.round((util.parseDate(end > today ? today : end) - util.parseDate(start)) / 86400000) + 1
  const days = passed > 0 ? passed : 1
  const r = v => Math.round(v * 100) / 100
  const balance = income - expense
  return {
    expense: r(expense), income: r(income), balance: r(balance),
    avgExpense: r(expense / days), avgIncome: r(income / days), avgBalance: r(balance / days),
    transfer: r(transfer), repay: r(repay), collect: r(collect),
    borrow: r(borrow), lend: r(lend), fee: r(fee),
    reimburse: r(reimburse), reimbursed: r(reimbursed), reimbursePending: r(reimburse - reimbursed),
    refund: r(refund), refundIncome: 0, refundExpense: r(refund)
  }
}

// 首页卡片全部可选指标的当前值（首页与数据设置页共用，保证两处数值一致）
function getCardMetrics() {
  const now = new Date()
  const ym = util.monthKey(now.getFullYear(), now.getMonth() + 1)
  const m = getMetrics(ym)
  const todayStr = util.dateStr(now)
  // 本周以周一为起点
  const wd = now.getDay()
  const mondayOff = wd === 0 ? 6 : wd - 1
  const weekStart = util.dateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOff))
  const yearPrefix = now.getFullYear() + '-'

  let todayExpense = 0, todayIncome = 0
  let weekExpense = 0, weekIncome = 0
  let yearExpense = 0, yearIncome = 0
  let allExpense = 0, allIncome = 0
  getBillsSync().forEach(b => {
    const ft = flowType(b)
    if (ft === 'expense') {
      const eff = statExpense(b)
      allExpense += eff
      if (b.date === todayStr) todayExpense += eff
      if (b.date >= weekStart) weekExpense += eff
      if (b.date.indexOf(yearPrefix) === 0) yearExpense += eff
    } else if (ft === 'income') {
      const inc = statIncome(b)
      allIncome += inc
      if (b.date === todayStr) todayIncome += inc
      if (b.date >= weekStart) weekIncome += inc
      if (b.date.indexOf(yearPrefix) === 0) yearIncome += inc
    }
  })
  const summary = getAssetSummary()
  const elapsed = now.getDate()
  const r = v => Math.round(v * 100) / 100
  return Object.assign({}, m, {
    todayExpense: r(todayExpense), todayIncome: r(todayIncome),
    todayBalance: r(todayIncome - todayExpense),
    weekExpense: r(weekExpense), weekIncome: r(weekIncome),
    weekBalance: r(weekIncome - weekExpense),
    yearExpense: r(yearExpense), yearIncome: r(yearIncome),
    yearBalance: r(yearIncome - yearExpense),
    allExpense: r(allExpense), allIncome: r(allIncome),
    allBalance: r(allIncome - allExpense),
    dailyIncomeAvg: r(elapsed ? m.income / elapsed : 0),
    totalAssets: summary.assets,
    totalLiability: summary.liability,
    netAssets: summary.net
  })
}

// 月内按分类聚合（统计页用）
// 一批账单按分类（bySub=true 时按 分类+子分类）聚合：金额、笔数、占比、条形图比例
function categoryStats(bills, type, bySub) {
  const map = {}
  bills.forEach(b => {
    if (flowType(b) !== type) return
    const sub = bySub ? (b.sub || '') : ''
    const key = b.catId + '|' + sub
    if (!map[key]) map[key] = { key, catId: b.catId, sub, total: 0, count: 0 }
    map[key].total += billAmount(b)
    map[key].count++
  })
  const list = Object.values(map)
  const grand = list.reduce((s, x) => s + x.total, 0)
  list.forEach(x => {
    x.total = Math.round(x.total * 100) / 100
    const c = getCat(x.catId, type)
    x.label = c ? c.label : '其他'
    if (bySub && x.sub) x.label = x.label + '-' + x.sub
    x.icon = c ? cats.iconPath(c.icon, false) : ''
    x.percent = grand ? x.total / grand * 100 : 0
  })
  list.sort((a, b) => b.total - a.total)
  const max = list.length ? list[0].total : 1
  list.forEach(x => { x.bar = x.total / max * 100 })
  const byKey = {}
  list.forEach(x => { byKey[x.key] = x })
  return { list, grand: Math.round(grand * 100) / 100, byKey }
}

// 月内每日收支（日历用）
function monthDayMap(ym) {
  const map = {}
  monthBills(ym).forEach(b => {
    if (!map[b.date]) map[b.date] = { date: b.date, expense: 0, income: 0 }
    const ft = flowType(b)
    if (ft === 'expense') map[b.date].expense += statExpense(b)
    if (ft === 'income') map[b.date].income += statIncome(b)
  })
  return map
}

// ------------------------------------------------------------- 报销
// 报销到账记录 = refunds 里 kind==='reimburse' 的条目：和退款一样冲减该单支出、并把钱记入到账账户，
// 这样账户余额、待报销 / 已报销汇总都沿用现有口径，不需要第二套账。
function reimbursedTotal(b) {
  return Math.round((b.refunds || [])
    .filter(r => r.kind === 'reimburse')
    .reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100
}

// 账单的报销信息；未选报销账户 / 非支出单返回 null（详情页据此决定显示「报销账户 / 报销详情 / 报销」）
function reimburseInfo(b) {
  if (!b || b.type !== 'expense' || !b.reimburse) return null
  const accId = reimburseAccIdOf(b)
  if (!accId) return null
  const acc = getAccount(accId)
  const remain = Math.round(effectiveExpense(b) * 100) / 100 // 还没被退款 / 报销冲掉的支出
  const done = !!b.reimburseDone
  return {
    accountId: accId,
    accountName: acc ? acc.name : (b.reimburseAccount || ''),
    accountIcon: acc ? acc.icon : '',
    received: reimbursedTotal(b),
    remain,
    done,
    canReimburse: !done && remain > 0.004,
    records: (b.refunds || []).filter(r => r.kind === 'reimburse')
  }
}

// 记一笔报销到账。p = { amount, accountId, date, remark, finish }；返回 '' 成功，否则为错误提示
// 到账金额可以为 0，但必须同时勾选「结束报销」（表示这笔不再报了）
function addReimbursement(billId, p) {
  const b = getBill(billId)
  const info = reimburseInfo(b)
  if (!info) return '该账单未关联报销账户'
  if (info.done) return '该账单已结束报销'
  const amt = Math.round((Number(p.amount) || 0) * 100) / 100
  if (amt < 0) return '请输入到账金额'
  if (amt === 0 && !p.finish) return '请输入到账金额'
  if (amt > info.remain + 0.001) return '到账金额不能超过待报销 ' + info.remain
  const patch = {}
  if (amt > 0) {
    const acc = p.accountId ? getAccount(p.accountId) : null
    if (!acc) return '请选择到账账户'
    patch.refunds = (b.refunds || []).concat([{
      id: util.genId(), kind: 'reimburse', amount: amt,
      accountId: acc.id, account: acc.name,
      date: p.date || util.dateStr(), remark: String(p.remark || '').trim(),
      createTime: Date.now()
    }])
  }
  if (p.finish) patch.reimburseDone = true
  updateBill(billId, patch)
  return ''
}

// 重新开启报销（结束报销后反悔）
function reopenReimbursement(billId) {
  const b = getBill(billId)
  if (!b || !b.reimburseDone) return false
  updateBill(billId, { reimburseDone: false })
  return true
}

// ------------------------------------------------------------- 预算趋势
// 某月逐日的「累计支出 / 剩余预算」（只算计入预算的支出）。本月画到今天；
// 若本月（或未来月份）有日期在今天之后的账单，则画到最后一笔账单那天——
// 否则顶部「已支出 / 剩余预算」已经把它算进去了，趋势图却看不到，两处数字对不上。
function budgetTrend(ym) {
  const [y, m] = ym.split('-').map(Number)
  const dim = util.daysInMonth(y, m)
  const budget = getBudgetEffective(ym)
  const todayStr = util.dateStr()
  const curYM = todayStr.slice(0, 7)
  let last = ym === curYM ? Number(todayStr.slice(8, 10)) : (ym < curYM ? dim : 0)
  const daily = new Array(dim).fill(0)
  monthBills(ym).forEach(b => {
    if (b.type !== 'expense') return
    const d = Number(String(b.date).slice(8, 10))
    if (d >= 1 && d <= dim) {
      const v = budgetExpense(b)
      daily[d - 1] += v
      if (v > 0 && d > last) last = d // 未来日期的账单：趋势延伸到那一天
    }
  })
  const r = v => Math.round(v * 100) / 100
  const spent = []
  const left = []
  let cum = 0
  for (let i = 0; i < dim; i++) {
    if (i < last) {
      cum += daily[i]
      spent.push(r(cum))
      left.push(r(budget - cum))
    } else {
      spent.push(null)
      left.push(null)
    }
  }
  return { ym, dim, budget, last, spent, left }
}

// ------------------------------------------------------------- 列表装饰
// 债务账单的资金流向文案：借入 / 收款 = 债务账户 → 资金账户；借出 / 还款 = 资金账户 → 债务账户
function debtFlowPath(b) {
  const inflow = b.catId === 'borrow' || b.catId === 'collect'
  const payable = b.catId === 'borrow' || b.catId === 'repay' // 借入 / 还款 属于应付款（借入账户）
  const debtSide = b.debtAccount || (payable ? '借入账户' : '借出账户')
  const fundSide = b.account || '无账户'
  return inflow ? debtSide + ' → ' + fundSide : fundSide + ' → ' + debtSide
}

function decorate(b) {
  const c = getCat(b.catId, b.type)
  const icon = c ? cats.iconPath(c.icon, false) : ''
  let title = c ? c.label : ''
  const catLabel = c ? c.label : '未分类' // 自定义分类被删除后账单仍要能显示（与账单详情页同一兜底）
  let amount = util.money(b.amount)
  let amountClass = 'amt-dark'
  let origAmount = ''
  let debtPath = ''
  let debtGen = false
  const badges = []
  if (b.reimburse && b.type === 'expense') {
    if (!b.reimburseDone) badges.push({ t: '待报销', cls: 'bd-reimb' })
    else if (reimbursedTotal(b) > 0) badges.push({ t: '已报销', cls: 'bd-refund' })
  }
  if (b.noCount) badges.push({ t: '不计收支', cls: 'bd-gray' })
  else if (b.noBudget && b.type === 'expense') badges.push({ t: '不计预算', cls: 'bd-gray' })
  const tagList = b.tag ? [b.tag] : []

  if (b.type === 'expense') {
    title = catLabel + (b.sub ? '-' + b.sub : '')
    const rt = refundTotal(b)
    const mrt = Math.round((rt - reimbursedTotal(b)) * 100) / 100 // 商家退款（报销到账不算退款）
    amount = '-' + util.money(effectiveExpense(b))
    amountClass = 'amt-red'
    if (mrt > 0) {
      badges.push({ t: '退' + (Number.isInteger(mrt) ? mrt : util.money(mrt)), cls: 'bd-refund' })
    }
    if (rt > 0) origAmount = util.money(b.amount)
  } else if (b.type === 'income') {
    title = '收入-' + catLabel + (b.sub ? '-' + b.sub : '')
    amount = '+' + util.money(b.amount)
    amountClass = 'amt-green'
  } else if (b.type === 'transfer') {
    // 转账卡片：标题「转账」，金额下方灰字写「转出账户 → 转入账户」（与借入 / 借出卡片同一位置同一样式）
    amount = util.money(b.amount)
    debtPath = (b.account || '?') + ' → ' + (b.toAccount || '?')
    const fee = billFee(b)
    if (fee > 0) badges.push({ t: '手续费' + util.money(fee), cls: 'bd-gray' })
  } else if (b.type === 'debt') {
    // 借入 / 借出账单卡片：标题只写操作（借入 / 借出 / 还款 / 收款），
    // 金额下方灰字写资金流向「来源 → 去向」，如「中国银行信用卡 → 借出账户」「借入账户 → 支付宝」。
    // 债务一侧写具体债务账户名；没挂债务账户的老账单用「借入账户 / 借出账户」。
    // 勾选了「生成账单」（计入收支，noCount 为 false）：金额带 ± 号并上色（借入 / 收款 +绿，借出 / 还款 −红），
    // 列表上同时显示这笔的备注；没勾选的保持无符号、不上色，只调整债务账户余额。
    debtGen = !b.noCount
    if (debtGen) {
      const inflow = b.catId === 'borrow' || b.catId === 'collect'
      amount = (inflow ? '+' : '-') + util.money(b.amount)
      amountClass = inflow ? 'amt-green' : 'amt-red'
    }
    const dfee = billFee(b)
    if (dfee > 0) badges.push({ t: '手续费' + util.money(dfee), cls: 'bd-gray' })
    debtPath = debtFlowPath(b)
  }
  return {
    id: b.id, icon, title, badges, tags: tagList,
    remark: b.remark, accountName: b.account, debtPath, debtGen,
    amount, amountClass, origAmount, raw: b
  }
}

function groupBills(bills) {
  bills = bills.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return b.createTime - a.createTime
  })
  const groups = []
  bills.forEach(b => {
    let g = groups[groups.length - 1]
    if (!g || g.date !== b.date) {
      g = {
        date: b.date,
        md: util.md(b.date),
        week: util.weekday(b.date),
        income: 0, expense: 0,
        items: []
      }
      groups.push(g)
    }
    const ft = flowType(b)
    if (ft === 'income') g.income += statIncome(b)
    if (ft === 'expense') g.expense += statExpense(b)
    g.items.push(decorate(b))
  })
  groups.forEach(g => {
    g.incomeText = util.money(g.income)
    g.expenseText = util.money(g.expense)
  })
  return groups
}

// ------------------------------------------------------------- 搜索
function search(opt) {
  opt = opt || {}
  let list = getBillsSync()
  if (opt.type) list = list.filter(b => b.type === opt.type)
  if (opt.start) list = list.filter(b => b.date >= opt.start)
  if (opt.end) list = list.filter(b => b.date <= opt.end)
  if (opt.kw) {
    const kw = opt.kw.trim().toLowerCase()
    list = list.filter(b => {
      const c = getCat(b.catId, b.type)
      const hay = [
        c ? c.label : '', b.sub, b.remark, b.tag,
        b.account, b.toAccount, util.money(b.amount)
      ].join(' ').toLowerCase()
      return hay.indexOf(kw) >= 0
    })
  }
  return groupBills(list)
}

// ------------------------------------------------------------- 初始化
// 一次性清理旧版本写入的演示账单与预算；之后不再写入任何演示数据
function clearDemoData() {
  if (wx.getStorageSync(K_CLEANED)) return
  const bills = getBillsSync()
  const rest = bills.filter(b => !(b && typeof b.id === 'string' && b.id.indexOf('seed-') === 0))
  if (rest.length !== bills.length) put(K_BILLS, rest)
  drop(K_BUDGET)
  drop(K_BUDGET_CONF)
  drop(K_SEED)
  put(K_CLEANED, 1)
}

function initDefaults() {
  clearDemoData()
  migrateCatPrefs()
  getAccounts(true) // 保证默认账户已写入
  postAnnualFees()
  postDepositIncome()
}

module.exports = {
  METRICS, DEFAULT_CARD, DEFAULT_BUDGET_CONF,
  getBillsSync, getBill, addBill, updateBill, removeBill, mergeBills,
  clearAllData, clearLocalLedger, getLedgerOwner, claimLedger, ledgerOwnedByOther, initDefaults, clearDemoData,
  metaTime, getMeta, applyMeta, pullFromCloud, syncAll, syncFresh, pendingSyncInfo, startLiveSync, stopLiveSync, onRemoteChange, revision, cloudLoggedIn,
  defaultAccounts, getAccounts, getAccount, saveAccount, removeAccount, reorderAccounts,
  accountBalance, getAssetSummary, getAccountViews, accountBills, accIdOf,
  isCreditAccount, creditInfo, accountStats, postAnnualFees,
  getDeposits, getDeposit, saveDeposit, removeDeposit, depositSummary, postDepositIncome,
  isDepositActive, depositHeld, availableBalance, checkDepositFunds, withdrawDeposit,
  isReimburseAccount, reimburseAccIdOf, reimburseBills, reimburseAmounts, reimburseSummary, getDebtViews, debtSummary, debtDetail, debtPending,
  getBudget, getBudgetConf, setBudgetConf, getBudgetEffective,
  getMonthlyDefault, setMonthlyDefault, setMonthOverride, clearMonthOverride, hasMonthOverride,
  getBudgetPeriods, getBudgetPeriod, addBudgetPeriod, updateBudgetPeriod, removeBudgetPeriod, periodExpense,
  getCardConfig, setCardConfig, getViewMode, setViewMode, getTimeRange, setTimeRange,
  allCats, getCat, visibleCats, saveCatOrder, addCustomCat, updateCat, removeCat,
  getHiddenCats, setCatHidden, clearHiddenCats, subsOf, saveSubs, categoryTree,
  lastAccountId, setLastAccountId,
  getTemplates, addTemplate, removeTemplate,
  tagStats, renameTag, deleteTag,
  DEFAULT_AVATAR, randomNick, getUser, setUser, ensureUserProfile, saveAvatar, userStats,
  monthBills, getMetrics, getCardMetrics, categoryStats, monthDayMap, periodStats,
  refundTotal, effectiveExpense, billAmount, flowType, statExpense, statIncome, budgetExpense, removeRefund, updateRefund,
  reimbursedTotal, reimburseInfo, addReimbursement, reopenReimbursement, budgetTrend,
  flushMeta, retryMetaIfDirty,
  groupBills, decorate, search, netEffect, billFee, subscribe
}
