// utils/ai.js
/**
 * AI 智能记账
 *
 * 流程：用户一句话 → 云函数 ai-recognize（大模型）→ 本文件校验 → [{ type, catId, sub, amount, date, remark,
 *       accountId, toAccountId, reimburse, tag, source }]（一句话可以拆成多笔，早餐/午餐/晚餐各记各的）
 *   - 请求里带上当前用户可用的分类树（store.categoryTree）和账户/已有标签，云函数据此出题，自己不带任何表；
 *   - 校验只在这里做一次（accept）：类型/分类必须在分类树内，子分类/账户/标签不在则置空，金额取正，
 *     任何一笔不合格都整句回退到本地关键词规则；
 *   - 日期：句子里只有一个相对日期词（昨天/前天…）时以本地推算为准，不信任模型的日期算术；
 *   - 备注只保留商品/事项名称：日期、金额、账户、餐别词都不进备注；
 *   - 账户：用户没说就是 ''（无账户），不再默认微信钱包；
 *   - 云环境未配置、云函数未部署、超时、出错同样回退，记账入口始终可用；
 *   - 登录门禁：未登录时 recognizeAll 直接拒绝、classifyRecords 全部走本地规则（cloud.callFn 也会拒绝），不会发出任何云请求。
 */
const cloud = require('./cloud')
const store = require('./store')
const cats = require('./categories')
const kinds = require('./accountKinds')
const util = require('./util')

// 关键词 -> 分类（顺序即优先级：越具体越靠前，泛词「买」放最后）
const RULES = [
  { type: 'transfer', catId: 'transfer', test: /转账|转给|汇给|汇款/ },

  { type: 'debt', catId: 'lend', test: /借给|借出|外借/ },
  { type: 'debt', catId: 'borrow', test: /借入|借了|跟.{1,4}借|向.{1,4}借/ },

  { type: 'income', catId: 'salary', test: /工资|薪水|发薪|薪资/ },
  { type: 'income', catId: 'part', test: /兼职|外快|副业/ },
  { type: 'income', catId: 'bonus', test: /奖金|年终奖|分红/ },
  { type: 'income', catId: 'invest', test: /理财|利息|基金|股票|收益/ },
  { type: 'income', catId: 'red', test: /红包/ },
  { type: 'income', catId: 'refund', test: /退款|退货|报销到账/ },

  { type: 'expense', catId: 'home', test: /话费|宽带|水费|电费|燃气|房租|物业/ },
  { type: 'expense', catId: 'food', test: /餐|饭|外卖|夜宵|宵夜|早点|拉面|面条|米粉|饺子|包子|火锅|烧烤|粥|汉堡|披萨|奶茶|咖啡|零食|水果|喝|菜/ },
  { type: 'expense', catId: 'shopping', test: /淘宝|京东|拼多多|购物|衣服|鞋子|超市/ },
  { type: 'expense', catId: 'transport', test: /打车|滴滴|地铁|公交|加油|高铁|火车|机票|出行/ },
  { type: 'expense', catId: 'fun', test: /电影|游戏|唱歌|k歌|旅游|门票|娱乐/ },
  { type: 'expense', catId: 'medical', test: /药|医院|挂号|体检|看病|门诊/ },
  { type: 'expense', catId: 'edu', test: /书|课程|培训|学费|教育/ },
  { type: 'expense', catId: 'gift', test: /礼物|送礼|请客|人情/ },
  { type: 'expense', catId: 'other', test: /理发|罚款|赔偿|捐款|捐助/ },
  { type: 'expense', catId: 'shopping', test: /买/ }
]

// 子分类关键词；只有属于所选分类的子分类才会被采用（顺序即优先级：明说哪一餐 > 外卖 > 其他）
const SUB_HINT = [
  ['话费宽带', /话费|宽带/], ['水电燃气', /水费|电费|燃气/], ['房租物业', /房租|物业/],
  ['早餐', /早餐|早饭|早点/], ['午餐', /午餐(?!肉)|午饭|中饭|中午吃/], ['晚餐', /晚餐|晚饭|晚上吃/], ['夜宵', /夜宵|宵夜/],
  ['外卖', /外卖/], ['饮品', /奶茶|咖啡|喝/],
  ['零食水果', /零食|水果/], ['日用百货', /超市|日用/], ['服饰鞋包', /衣服|鞋子/],
  ['公交地铁', /地铁|公交/], ['打车', /打车|滴滴/], ['加油', /加油/],
  ['电影演出', /电影|门票/], ['旅游度假', /旅游/],
  ['药品', /药/], ['门诊', /医院|挂号|门诊/],
  ['理发', /理发/], ['罚款赔偿', /罚款|赔偿/], ['慈善捐助', /捐款|捐助/]
]

// 账户口语别名 -> 用户账户（按类型或名称匹配）
const ACC_ALIAS = [
  [/微信|wx|vx|weixin/i, a => a.type === 'wechat'],
  [/支付宝|zfb|alipay/i, a => a.type === 'alipay'],
  [/现金/, a => a.type === 'cash'],
  [/信用卡/, a => a.type === 'credit'],
  [/招行|招商/, a => /招商/.test(a.name)],
  [/中行|中国银行/, a => /中国银行/.test(a.name)],
  [/网商/, a => /网商/.test(a.name)]
]

// 小程序当前的账户（不含隐藏）与已有标签，随请求发给云函数
function getContext() {
  return {
    accounts: store.getAccounts(false).map(a => ({ id: a.id, name: a.name, type: a.type, alias: a.alias || '' })),
    tags: store.tagStats().slice(0, 20).map(t => t.tag)
  }
}

// 发给云函数的上下文。云函数只取前 20 个账户 / 20 个标签，并且序列化后超过 3000 字符就把整份上下文丢掉，
// 账户多的用户会因此静默失去账户 / 标签识别；所以这里只带能收付款的账户（债务 / 报销账户不是），按云函数的字段与上限裁好
function requestContext(ctx) {
  return {
    accounts: ctx.accounts.filter(a => kinds.groupOf(a) !== 'debt').slice(0, 20)
      .map(a => ({ id: a.id, name: a.name, alias: a.alias })),
    tags: ctx.tags
  }
}

function findAccountId(text, accounts) {
  const byName = accounts.find(a => a.name && text.indexOf(a.name) >= 0)
  if (byName) return byName.id
  // 账户「简称」（账户编辑页设置）：一句话里出现简称即匹配该账户
  const byAlias = accounts.find(a => a.alias && text.indexOf(a.alias) >= 0)
  if (byAlias) return byAlias.id
  for (let i = 0; i < ACC_ALIAS.length; i++) {
    if (ACC_ALIAS[i][0].test(text)) {
      const a = accounts.find(ACC_ALIAS[i][1])
      if (a) return a.id
    }
  }
  return ''
}

// 金额：优先取带「元/块/¥」的数字；没有单位时取最后一个数字（「3个苹果15」应是 15，而不是 3）
// 返回 { value, start, end }（start/end 是它在原文中的位置，用来把它从备注里剔除）
function findAmount(text) {
  let m = /(\d+(?:\.\d+)?)\s*(?:元|块|rmb|RMB)/.exec(text) || /[¥￥]\s*(\d+(?:\.\d+)?)/.exec(text)
  if (!m) {
    const re = /\d+(?:\.\d+)?/g
    let x
    while ((x = re.exec(text))) m = x
    if (m) return { value: Number(m[0]), start: m.index, end: m.index + m[0].length }
    return null
  }
  return { value: Number(m[1]), start: m.index, end: m.index + m[0].length }
}

// ------------------------------------------------ 日期解析
function shiftDateStr(delta) {
  const d = new Date()
  d.setDate(d.getDate() + delta)
  return util.dateStr(d)
}

// “M月D日”：若推出的日期在今天之后，按去年处理（记账多为补记过去的账）
function parseMD(month, day) {
  const now = new Date()
  let d = new Date(now.getFullYear(), month - 1, day)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  if (d > today) d = new Date(now.getFullYear() - 1, month - 1, day)
  return util.dateStr(d)
}

// 相对日期词 -> 距今天数（大前天必须排在前天之前，扫描时按最长匹配先消费）
const REL_DAY = { '大前天': -3, '前天': -2, '昨天': -1, '昨晚': -1, '今天': 0, '今日': 0, '今晚': 0, '明天': 1, '明日': 1, '后天': 2, '大后天': 3 }
const REL_DAY_RE = /大前天|大后天|前天|昨天|昨晚|今天|今日|今晚|明天|明日|后天/g

// 句子里出现的相对日期词对应的日期列表（按出现顺序，去重）
function relativeDates(text) {
  const out = []
  const ms = String(text).match(REL_DAY_RE) || []
  ms.forEach(w => {
    const d = shiftDateStr(REL_DAY[w])
    if (out.indexOf(d) < 0) out.push(d)
  })
  return out
}

// “周五 / 上周五 / 这周三”
function weekdayDate(text) {
  const m = text.match(/(上个?|这个?|本)?(?:周|星期)([一二三四五六日天])/)
  if (!m) return null
  const target = '一二三四五六日'.indexOf(m[2] === '天' ? '日' : m[2]) // 周一=0 … 周日=6
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const d = new Date(monday)
  d.setDate(monday.getDate() + target - (m[1] && m[1][0] === '上' ? 7 : 0))
  if (!m[1] && d > today) d.setDate(d.getDate() - 7) // 单说「周五」指最近已过去的那个
  return util.dateStr(d)
}

// 从一句话里识别账单日期；识别不到返回 null
function explicitDate(text) {
  const rel = relativeDates(text)
  if (rel.length) return rel[0]
  let m = text.match(/(\d{1,2})月(\d{1,2})[日号]/)
  if (m) return parseMD(Number(m[1]), Number(m[2]))
  m = text.match(/(\d{1,2})[日号](?!\d)/) // “3号”（不带月份）
  if (m) return parseMD(new Date().getMonth() + 1, Number(m[1]))
  return weekdayDate(text)
}

// 识别不到默认今天
function parseDateHint(text) {
  return explicitDate(text) || util.dateStr()
}

function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !isNaN(util.parseDate(s).getTime())
}

// ------------------------------------------------ 备注清洗：只留商品/事项名称
const DATE_WORDS = /大前天|大后天|前天|昨天|昨晚|今天|今日|今晚|明天|明日|后天|(?:上个?|这个?|本)?(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|\d{1,2}[日号](?!\d)|凌晨|早上|上午|中午|下午|晚上/g
const MEAL_WORDS = /早餐|早饭|早点|午餐(?!肉)|午饭|中饭|晚餐|晚饭|夜宵|宵夜/g
const AMOUNT_WORDS = /(?:\d+(?:\.\d+)?)\s*(?:元|块钱|块|rmb|RMB)|[¥￥]\s*\d+(?:\.\d+)?/g
const ACC_WORDS = '微信|wx|vx|支付宝|zfb|现金|信用卡|银行卡|招行|中行'

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * 去掉日期/时段词、金额、账户、餐别词和「花了/买了/吃了」这类动词，只留商品名。
 * opts.accounts 用户账户（名称也要剔除）；opts.food 为餐饮支出时才剔除餐别词（它们已体现在子分类里）。
 */
function cleanRemark(text, opts) {
  opts = opts || {}
  const accNames = (opts.accounts || []).map(a => esc(a.name)).filter(Boolean)
  const accRe = new RegExp('(?:用|通过|刷|从|由)?(?:' + accNames.concat(ACC_WORDS.split('|')).join('|') +
    ')(?:钱包|支付|付款|付的|付了|付)?', 'ig')
  let r = String(text || '')
    .replace(AMOUNT_WORDS, ' ')
    .replace(DATE_WORDS, ' ')
    .replace(accRe, ' ')
  if (opts.food) r = r.replace(MEAL_WORDS, ' ')
  r = r.replace(/(?:不|可|能|要|需要|公司)*报销/g, ' ')
  // 先剥掉句尾的「花了/付了」（此时「了」还在），再去标点和虚词
  const EDGE = /^[\s,，。.、;；:：!！?？]+|[\s,，。.、;；:：!！?？]+$/g
  const WEAK = /^[\s,，。.、;；:：!！?？的了在是]+|[\s,，。.、;；:：!！?？的了]+$/g
  r = r.replace(EDGE, '')
  r = r.replace(/(?:一共|总共|共计|合计)?(?:花了|花费了?|用了|付了|支付了?|消费了?|付款了?|共计|合计)$/, '')
  r = r.replace(EDGE, '')
  r = r.replace(/^(?:我)?(?:买了|买|吃了|吃|喝了|喝|点了|点)/, '')
  r = r.replace(/^给(.+?)(?:转账|汇款)$/, '$1').replace(/^(?:转账给|转给|汇给)/, '')
  r = r.replace(/\s+/g, ' ').replace(WEAK, '')
  if (/^(?:饭|餐|东西|一顿|一点|了|的)?$/.test(r)) return ''
  return r.slice(0, 50)
}

function localRecognize(text, ctx) {
  ctx = ctx || getContext()
  const base = RULES.find(r => r.test.test(text)) || { type: 'expense', catId: 'other' }
  const own = (cats.getCat(base.catId, base.type) || {}).subs || []
  const sh = SUB_HINT.find(x => own.indexOf(x[0]) >= 0 && x[1].test(text))
  const amt = findAmount(text)
  // 把识别出的金额从文本里挖掉再清洗备注（无单位的裸数字 AMOUNT_WORDS 匹配不到）
  const rest = amt ? text.slice(0, amt.start) + ' ' + text.slice(amt.end) : text
  return {
    type: base.type,
    catId: base.catId,
    sub: sh ? sh[0] : '',
    amount: amt ? amt.value : 0,
    date: parseDateHint(text),
    remark: cleanRemark(rest, { accounts: ctx.accounts, food: base.type === 'expense' && base.catId === 'food' }),
    // 转账需要明确的两端账户，本地规则不去猜；其余类型只认用户明说的账户，没说就是无账户
    accountId: base.type === 'transfer' ? '' : findAccountId(text, ctx.accounts),
    toAccountId: '',
    reimburse: base.type === 'expense' && /报销/.test(text) && !/不报销|已报销|报销到账/.test(text),
    tag: '',
    source: 'local'
  }
}

// 校验并归一化云端的一笔账；分类不在用户的分类树里则视为无效（返回 null，由调用方整句回退本地识别）
function accept(r, tree, text, ctx) {
  if (!r || !tree[r.type] || !tree[r.type][r.catId]) return null
  const amount = Number(String(r.amount).replace(/[^\d.]/g, '')) // 金额恒为正，方向由 type 表示
  const hasAcc = id => typeof id === 'string' && ctx.accounts.some(a => a.id === id)
  const accountId = hasAcc(r.accountId) ? r.accountId : '' // 没说 / 不存在 → 无账户
  let toAccountId = r.type === 'transfer' && hasAcc(r.toAccountId) ? r.toAccountId : ''
  if (toAccountId === accountId) toAccountId = ''
  // 句子里只有一个相对日期词时，本地推算优先于模型的日期算术；多个日期词（「昨天早餐今天午餐」）信模型
  const rel = relativeDates(text)
  const date = rel.length === 1 ? rel[0] : (validDate(r.date) ? r.date : parseDateHint(text))
  return {
    type: r.type,
    catId: r.catId,
    sub: tree[r.type][r.catId].subs.indexOf(r.sub) >= 0 ? r.sub : '',
    amount: isFinite(amount) ? Math.round(amount * 100) / 100 : 0,
    date,
    remark: cleanRemark(r.remark, { accounts: ctx.accounts, food: r.type === 'expense' && r.catId === 'food' }),
    accountId,
    toAccountId,
    reimburse: r.type === 'expense' && (r.reimburse === true || r.reimburse === 'true'),
    tag: ctx.tags.indexOf(r.tag) >= 0 ? r.tag : '',
    source: 'cloud'
  }
}

/**
 * 识别入口：一句话 → 一笔或多笔账
 * @param {string} text 用户输入
 * @returns Promise<Array<{type,catId,sub,amount,date,remark,accountId,toAccountId,reimburse,tag,source}>>
 */
function recognizeAll(text) {
  text = String(text || '').trim()
  if (!text) return Promise.reject(new Error('内容为空'))
  // 智能记账是登录后的功能：未登录不识别（入口处 auth.requireLogin 已拦；这里是第二道闸，不会发出云请求）
  if (!cloud.isLoggedIn()) return Promise.reject(new Error('not-logged-in'))
  const ctx = getContext()
  // 回退本地识别；原因写进日志，否则「登录了却一直是本地识别」没法区分是云函数没部署 / 超时 / 没配密钥 / 模型乱答
  const local = why => {
    console.warn('[ai] 回退本地识别：', why)
    return [localRecognize(text, ctx)]
  }
  if (!cloud.ready()) return Promise.resolve(local('云开发未就绪'))
  const tree = store.categoryTree()
  return cloud.callFn('ai-recognize', { text, taxonomy: tree, context: requestContext(ctx) })
    .then(res => {
      const raw = res && Array.isArray(res.items) ? res.items : null
      if (!raw || !raw.length) return local('云函数没有返回账单')
      const items = raw.map(r => accept(r, tree, text, ctx))
      return items.every(Boolean) ? items : local('返回的分类不在用户分类树内')
    })
    .catch(local)
}

// 记账弹窗里用户手动选的日期/标签/账户/报销，覆盖识别结果。
// ov 只包含「用户动过」的字段（未动的字段保持识别结果，比如一句话里的「昨天」仍然生效）：
//   { date?: 'YYYY-MM-DD', tag?: string, accountId?: string（'' = 无账户）, reimburse?: boolean }
// 另有 defaultAccountId：用户没动账户 chip 时的默认账户（上次手动选的），只补给一句话里没说账户的账单。
// 转账需要明确的两端账户，弹窗里只有一个账户 chip，所以不覆盖转账的账户；报销只对支出有意义。
function applyOverrides(list, ov) {
  ov = ov || {}
  const has = k => ov[k] !== undefined && ov[k] !== null
  return list.map(r => {
    const x = Object.assign({}, r)
    if (has('date')) x.date = ov.date
    if (has('tag')) x.tag = ov.tag
    if (x.type !== 'transfer') {
      if (has('accountId')) x.accountId = ov.accountId
      else if (!x.accountId && has('defaultAccountId')) x.accountId = ov.defaultAccountId
    }
    if (has('reimburse') && x.type === 'expense') x.reimburse = !!ov.reimburse
    return x
  })
}

// 能否不经确认直接入账：要有金额；转账还必须明确两端账户（转账不允许「无账户」）
function isComplete(r) {
  if (!(r.amount > 0)) return false
  return r.type !== 'transfer' || !!(r.accountId && r.toAccountId)
}

// 识别结果 → 账单。没指定账户就是「无账户」（accountId ''），不再默认微信钱包
function toBill(r) {
  const acc = r.accountId ? store.getAccount(r.accountId) : null
  const bill = {
    type: r.type, catId: r.catId, sub: r.sub,
    amount: r.amount, date: r.date, remark: r.remark,
    accountId: acc ? acc.id : '', account: acc ? acc.name : '无账户',
    reimburse: !!r.reimburse,
    via: 'ai' // 记录方式：智能记账（账单详情页「记录方式」显示用）
  }
  if (r.tag) bill.tag = r.tag
  if (r.type === 'transfer') {
    const to = store.getAccount(r.toAccountId)
    if (to) { bill.toAccountId = to.id; bill.toAccount = to.name }
  }
  return bill
}

// 不能直接入账时，带着已识别的字段跳记账页让用户补全（字段名与记账页预填参数一致）
function prefillQuery(r) {
  return util.toQuery({
    type: r.type, catId: r.catId, sub: r.sub, date: r.date, remark: r.remark,
    amount: r.amount > 0 ? r.amount : undefined,
    accountId: r.accountId || undefined,
    toAccountId: r.toAccountId || undefined,
    noAcc: r.type !== 'transfer' && !r.accountId ? '1' : undefined,
    reimburse: r.reimburse ? '1' : undefined,
    tag: r.tag || undefined
  })
}

// ------------------------------------------------------------------ Excel 导入：批量分类
// 一行流水 → 分类 / 子分类 / 备注。只把「交易对方 + 商品 + 备注」这类文字和收支方向发给云函数（不含金额、日期、账户），
// 相同文字的行只问一次；云函数没配置 / 失败 / 返回的分类不在用户分类树里，就退回本地关键词规则，导入不会因此中断。
const ROW_BATCH = 15      // 每次请求带多少行
const ROW_PARALLEL = 3    // 同时几个请求
const MAX_AI_KEYS = 300   // 一次导入最多问 AI 多少种不同的文字，超出的走本地规则（控制调用量）

function fallbackCatId(tree, type) {
  return tree[type].other ? 'other' : Object.keys(tree[type])[0]
}

// 本地规则：只在 type 对应的规则里找（支出行不会被分到收入）；一条都没命中 weak=true，落到「其他」
function localCategory(text, type, tree) {
  const rule = RULES.find(r => r.type === type && r.test.test(text) && tree[type][r.catId])
  const catId = rule ? rule.catId : fallbackCatId(tree, type)
  const own = tree[type][catId].subs
  const sh = SUB_HINT.find(x => own.indexOf(x[0]) >= 0 && x[1].test(text))
  return { catId, sub: sh ? sh[0] : '', weak: !rule }
}

// 原表里的分类名能对上用户的分类 → { catId, sub }（子分类对不上就留空）；对不上返回 null
function resolveHint(rec, tree) {
  const cats = tree[rec.type]
  const catId = Object.keys(cats).find(id => cats[id].label === rec.catHint)
  if (!catId) return null
  return { catId, sub: cats[catId].subs.indexOf(rec.subHint) >= 0 ? rec.subHint : '' }
}

// 并发度受限地依次执行一组返回 Promise 的任务
function runPool(tasks, limit) {
  let next = 0
  const worker = () => {
    if (next >= tasks.length) return Promise.resolve()
    return tasks[next++]().then(worker)
  }
  return Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
}

/**
 * 给流水记录分类（原地写入 rec.catId / sub / remark / source / weak）。
 * @param records  excelBills.parseWorkbook 的 records（type 为 expense / income 的才需要分类，其余原样放过）
 * @param opts     { trustCats: 表里自带「一级分类 + 子分类」两列（本应用导出的文件）：分类名对得上就直接沿用，不再问 AI;
 *                   onProgress(done, total) }
 * @returns Promise<{ exact, cloud, local, weak, capped, aiUnavailable, needLogin, aiFailed }> 各来源的笔数（needLogin=未登录所以没用 AI）
 */
function classifyRecords(records, opts) {
  opts = opts || {}
  const tree = store.categoryTree()
  // AI 分类是登录后的功能：未登录时全部走本地关键词规则（导入本身是本地功能，照常可用），不发云请求
  const loggedIn = cloud.isLoggedIn()
  const stats = { exact: 0, cloud: 0, local: 0, weak: 0, capped: 0, aiUnavailable: !loggedIn || !cloud.ready(), needLogin: !loggedIn, aiFailed: 0 }
  const groups = {} // key → { type, desc, hint, recs }
  const setLocal = (rec, weakAllowed) => {
    const c = localCategory(rec.desc, rec.type, tree)
    Object.assign(rec, { catId: c.catId, sub: c.sub, remark: rec.remarkRaw || rec.desc.slice(0, 30), source: 'local', weak: c.weak && weakAllowed })
    stats.local++
    if (rec.weak) stats.weak++
  }

  records.forEach(rec => {
    if (rec.type !== 'expense' && rec.type !== 'income') return
    const hit = opts.trustCats ? resolveHint(rec, tree) : null
    if (hit) {
      Object.assign(rec, hit, { remark: rec.remarkRaw, source: 'exact', weak: false })
      stats.exact++
      return
    }
    if (!rec.desc && !rec.catHint) { setLocal(rec, true); return } // 没有任何文字可判断
    const hint = [rec.catHint, rec.subHint].filter(Boolean).join('/')
    const key = rec.type + '|' + rec.desc + '|' + hint
    if (!groups[key]) groups[key] = { type: rec.type, desc: rec.desc, hint, recs: [] }
    groups[key].recs.push(rec)
  })

  const keys = Object.keys(groups)
  const asked = stats.aiUnavailable ? [] : keys.slice(0, MAX_AI_KEYS)
  keys.slice(asked.length).forEach(k => {
    if (!stats.aiUnavailable) stats.capped += groups[k].recs.length
    groups[k].recs.forEach(rec => setLocal(rec, true))
  })

  const chunks = []
  for (let i = 0; i < asked.length; i += ROW_BATCH) chunks.push(asked.slice(i, i + ROW_BATCH))
  let done = 0
  const subTree = { expense: tree.expense, income: tree.income }
  const tasks = chunks.map(chunk => () => {
    const rows = chunk.map((k, i) => ({ i, type: groups[k].type, desc: groups[k].desc, hint: groups[k].hint }))
    return cloud.callFn('ai-recognize', { rows, taxonomy: subTree })
      .then(res => {
        const by = {}
        ;((res && res.items) || []).forEach(x => { if (x) by[x.i] = x })
        chunk.forEach((k, i) => {
          const g = groups[k]
          const x = by[i]
          if (x && tree[g.type][x.catId]) {
            const sub = tree[g.type][x.catId].subs.indexOf(x.sub) >= 0 ? x.sub : ''
            const remark = String(x.remark || '').trim().slice(0, 50)
            g.recs.forEach(rec => {
              Object.assign(rec, { catId: x.catId, sub, remark: rec.remarkRaw || remark, source: 'cloud', weak: false })
              stats.cloud++
            })
          } else {
            g.recs.forEach(rec => setLocal(rec, true)) // 这一行云端没给出有效分类
          }
        })
      })
      .catch(() => {
        stats.aiFailed++
        chunk.forEach(k => groups[k].recs.forEach(rec => setLocal(rec, true)))
      })
      .then(() => { done++; if (opts.onProgress) opts.onProgress(done, chunks.length) })
  })
  return runPool(tasks, ROW_PARALLEL).then(() => stats)
}

// 账户文字（如「招商银行储蓄卡(1234)」「零钱」）→ 账户 id；对不上返回 ''。先取好账户列表，逐行匹配时不再反复读缓存
function accountMatcher() {
  const accounts = getContext().accounts
  // 微信账单的支付方式「零钱 / 零钱通」就是微信钱包；只在导入时这样认，不动语音记账的账户别名（「找零钱」不该变成微信）
  return text => (text ? findAccountId(/^零钱/.test(String(text)) ? '微信' + text : String(text), accounts) : '')
}

module.exports = {
  recognizeAll, localRecognize, isComplete, toBill, prefillQuery, applyOverrides,
  classifyRecords, accountMatcher
}
