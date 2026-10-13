// 云函数 ai-recognize：把一句话（如「午餐花了35元」）交给大模型，解析成记账字段。
//
// 入参  event = { text, taxonomy, context }
//   text      用户输入
//   taxonomy  小程序当前可用的分类树 { type: { catId: { label, subs: [] } } }（store.categoryTree）。
//             云函数自己不带分类表：自定义子分类、隐藏分类都由小程序决定，不会漂移。
//   context   可选 { accounts: [{ id, name, alias? }], tags: [string] }：用户当前的账户和已有标签，
//             让模型能识别「微信付的」「招行转给支付宝」，并且只能从中选择。
// 出参  { items: [{ type, catId, sub, amount, date, remark, accountId, toAccountId, reimburse, tag }] }
//       一句话里有几笔独立的账就返回几项（「早餐8午餐20」= 2 项，不合并）。原样转述模型的回答；
//       校验（分类/账户是否存在、金额归一化、日期合法性、回退本地规则）只在小程序端 utils/ai.js 做一次。
//
// 环境变量（云开发控制台 → 云函数 → ai-recognize → 函数配置 → 环境变量）：
//   AI_PROVIDER  openai（默认，任何 OpenAI 兼容接口）| anthropic
//   AI_API_KEY   密钥（必填）。只放环境变量，不要写进代码、不要提交到仓库
//   AI_MODEL     模型名（必填）
//   AI_MAX_TOKENS 可选，覆盖默认的输出上限（单句 800 / 批量 1500）；推理类模型（思考过程也计入）回答被截断时调大
//   AI_EXTRA_BODY 可选，一段 JSON 对象，并进请求体；用来关掉推理 / 思考，例如 {"enable_thinking":false}
//   AI_BASE_URL  openai 模式必填，例如 https://api.deepseek.com/v1 ；
//                anthropic 模式可不填（默认 https://api.anthropic.com）
//
// 第二种入参（Excel 导入的批量分类）：event = { rows, taxonomy }
//   rows      [{ i, type: 'expense'|'income', desc, hint }]，最多 20 行。i 是行序号，desc 是交易对方 / 商品 / 备注拼成的文字，
//             hint 是原表里的分类（可选，仅供参考）。type 由小程序按表里的收/支定好，模型不能改。
//   taxonomy  同上，只需要 expense / income 两棵
// 出参  { items: [{ i, catId, sub, remark }] }，每行最多一项。分类是否在用户分类树里同样由小程序端校验。
//
// 云函数默认超时只有 3 秒：单句识别请改成 10~15 秒；要用 Excel 批量分类，请改成 30 秒（一次请求最多 20 行）。
// 任何失败都会 throw：小程序端会自动回退到本地关键词识别，记账不受影响。

const http = require('http')
const https = require('https')

const MAX_TEXT = 200
const MAX_TAXONOMY = 6000 // 分类树序列化后的最大字符数，防止被塞入超大请求拉高调用成本
const MAX_CONTEXT = 3000  // 账户 + 标签序列化后的最大字符数
const MAX_ITEMS = 8       // 一句话最多拆成几笔
const MAX_ROWS = 20       // 批量分类一次最多几行

// 留给模型的等待时间：不超过 want，也不超过函数剩余时间减去 1.5 秒（留出整理结果、返回的时间，
// 这样函数超时会先以「LLM 请求超时」干净地失败，而不是被平台强杀）。
// 注意：部分运行时（node16 的 callbackContext）里 context.getRemainingTimeInMillis() 会直接抛
// TypeError: client.ms_elapsed is not a function，所以它只能是「可选」的：拿不到就按 want 走，绝不能让它拖垮整个调用
function llmBudget(context, want) {
  let left = Infinity
  try {
    const n = context && typeof context.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : Infinity
    if (Number.isFinite(n)) left = n
  } catch (e) { /* 运行时不支持，忽略 */ }
  return Math.max(1000, Math.min(want, left - 1500))
}

// 校验分类树的形状（不校验内容）：{ type: { catId: { label, subs: string[] } } }
function checkTaxonomy(t) {
  const ok = t && typeof t === 'object' && JSON.stringify(t).length <= MAX_TAXONOMY &&
    Object.keys(t).length > 0 &&
    Object.keys(t).every(type => t[type] && typeof t[type] === 'object' &&
      Object.keys(t[type]).every(id => {
        const c = t[type][id]
        return c && Array.isArray(c.subs) && c.subs.every(x => typeof x === 'string')
      }))
  if (!ok) throw new Error('taxonomy 缺失或格式不正确')
  return t
}

// 校验账户/标签上下文（可选）；形状不对就当作没有，不影响记账
function checkContext(c) {
  const empty = { accounts: [], tags: [] }
  if (!c || typeof c !== 'object' || JSON.stringify(c).length > MAX_CONTEXT) return empty
  const accounts = (Array.isArray(c.accounts) ? c.accounts : [])
    .filter(a => a && typeof a.id === 'string' && a.id && typeof a.name === 'string')
    .map(a => ({ id: a.id, name: a.name, alias: typeof a.alias === 'string' ? a.alias.slice(0, 12) : '' }))
    .slice(0, 20)
  const tags = (Array.isArray(c.tags) ? c.tags : []).filter(t => typeof t === 'string' && t).slice(0, 20)
  return { accounts, tags }
}

// 云函数运行在 UTC 时区：整体平移 8 小时后用 getUTC* / toISOString 读出的就是北京时间
function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000)
}

// YYYY-MM-DD 加减天数
function shiftDays(s, delta) {
  const d = new Date(s + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

// 分类树 → 提示词里的「- type：catId=名称(子分类/子分类)、…」多行文字
function taxonomyLines(tax) {
  return Object.keys(tax).map(type => {
    const cats = Object.keys(tax[type]).map(id => {
      const c = tax[type][id]
      return id + '=' + (c.label || id) + (c.subs.length ? '(' + c.subs.join('/') + ')' : '')
    }).join('、')
    return '- ' + type + '：' + cats
  }).join('\n')
}

function buildSystemPrompt(tax, ctx) {
  const lines = taxonomyLines(tax)
  const accLine = ctx.accounts.length
    ? ctx.accounts.map(a => a.id + '=' + a.name + (a.alias ? '（简称：' + a.alias + '）' : '')).join('、')
    : '（用户没有可选账户）'
  const tagLine = ctx.tags.length ? ctx.tags.join('、') : '（没有已有标签）'

  const now = bjNow()
  const today = now.toISOString().slice(0, 10)
  const hhmm = now.toISOString().slice(11, 16)
  const week = '日一二三四五六'[now.getUTCDay()]
  const y = shiftDays(today, -1)
  const yy = shiftDays(today, -2)

  return [
    '你是一个聪明、细心的记账助手。把用户的一句话解析成一笔或多笔账。用户的话可能很口语、有错别字、谐音、简称或省略，',
    '你要主动纠错、推断真实意图，再准确入账。只输出一个 JSON 对象，不要任何解释或代码块标记。',
    '输出格式：{"items":[{"type","catId","sub","amount","date","remark","accountId","toAccountId","reimburse","tag"}]}',
    '',
    '【拆分】一句话里有几笔独立的收支就输出几项，每项各有自己的金额、子分类，绝不合并。',
    '例如「早餐8块、午餐20、晚餐35」是 3 项，不能合成一笔。只有一个金额的一件事只输出 1 项。',
    '',
    '【类型与分类】type 取值 expense(支出) / income(收入) / transfer(转账) / debt(借入借出)。',
    '可选分类如下，格式「catId=名称(子分类/子分类)」，type、catId、sub 必须严格从中选择：',
    lines,
    'sub 要选最贴切的子分类，没有合适的就输出空字符串。无法判断分类时 type=expense, catId=other。',
    '餐饮的早餐/午餐/晚餐/夜宵是各自独立的子分类：根据用户说的哪一餐分别归类（早饭/早点→早餐，中饭/午饭/中午→午餐，',
    '晚饭→晚餐，宵夜→夜宵）。只有用户明确说外卖/美团/饿了么且没说是哪一餐时才选「外卖」。',
    '用户没说哪一餐，但明显是今天刚吃的一顿正餐（如「刚吃了碗面」），可按当前时间推断：05-10 点早餐，10-15 点午餐，',
    '15-21 点晚餐，其余夜宵；不是今天的、又没说哪一餐就留空。奶茶咖啡类归饮品，水果零食归零食水果。',
    '',
    '【日期】date 是 YYYY-MM-DD。现在是北京时间 ' + today + ' 周' + week + ' ' + hhmm + '。',
    '按用户提到的时间推算：今天=今天，昨天=' + y + '，前天=' + yy + '，大前天再减 1 天，「M月D日」按该月日推算，',
    '「周X / 上周X」取已经过去的那一天（上周X=上一个自然周的周X）。用户完全没提日期就取今天。',
    '日期、时间词只用来算 date，绝不能留在 remark 里。',
    '',
    '【备注】remark 只写商品/事项/对象本身的名称，例如「兰州拉面」「去机场」「妈妈」「房租」。',
    '绝不能包含：日期词（昨天/前天/上周五）、金额和币种、账户名、早/午/晚餐这类餐别词（已体现在 sub 里）、',
    '「花了/买了/吃了」之类的动词。顺手纠正错别字（「兰洲拉面」→「兰州拉面」）。没有具体名称时 remark 输出空字符串，不要复述原文。',
    '',
    '【金额】amount 是数字（元），没有金额输出 0。把中文数字和口语换成阿拉伯数字：「三十五块」→35，「两百」→200，',
    '「1.5k」→1500，「一千二」→1200，「20块5」→20.5。「3个苹果15」要区分数量和价钱，金额是 15。',
    '',
    '【账户】用户可用的账户，格式「id=名称」：' + accLine,
    'accountId 只能填上面的 id。用户明确提到某个账户（允许简称、口语、错别字，如微信/vx→微信钱包，zfb→支付宝，招行→招商银行）才填；',
    '没提到就输出空字符串 ""（表示「无账户」），绝对不要自己猜一个默认账户。',
    '转账：accountId 是转出账户，toAccountId 是转入账户，没提到的一端留空。借入借出：accountId 是收付款账户。其余类型 toAccountId 留空。',
    '',
    '【其他】reimburse 只有用户明确说可报销/公司报销/要报销时才为 true，否则 false，仅对支出有效。',
    'tag 只能从已有标签里选：' + tagLine + '。明显匹配才选，否则输出空字符串。',
    '',
    '示例仅演示格式和拆分方式，分类以上面的列表为准：',
    '用户「昨天中午吃兰洲拉面20块」→ {"items":[{"type":"expense","catId":"food","sub":"午餐","amount":20,"date":"' + y +
      '","remark":"兰州拉面","accountId":"","toAccountId":"","reimburse":false,"tag":""}]}',
    '用户「前天早餐8块 晚上火锅150」→ {"items":[' +
      '{"type":"expense","catId":"food","sub":"早餐","amount":8,"date":"' + yy + '","remark":"","accountId":"","toAccountId":"","reimburse":false,"tag":""},' +
      '{"type":"expense","catId":"food","sub":"晚餐","amount":150,"date":"' + yy + '","remark":"火锅","accountId":"","toAccountId":"","reimburse":false,"tag":""}]}'
  ].join('\n')
}

// ---------------------------------------------------------------- HTTP
function postJSON(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const lib = u.protocol === 'http:' ? http : https
    const data = JSON.stringify(body)
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers)
    }, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => { buf += c })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('LLM HTTP ' + res.statusCode + ' ' + buf.slice(0, 200)))
        }
        try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('LLM 返回不是 JSON')) }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('LLM 请求超时')))
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// ---------------------------------------------------------------- 调模型
// 每次调用后在云函数日志里留一行「谁回的、什么模型、用了多少 token」，对账时能确认请求到底发到了哪家（host 取自 AI_BASE_URL）
function trace(base, r) {
  const via = new URL(base).host + ' model=' + r.model + ' usage=' + JSON.stringify(r.usage || {})
  console.log('[ai-recognize]', via)
  return via
}

// AI_EXTRA_BODY：环境变量里的一段 JSON，原样并进请求体，用来传各家接口自己的参数——最常用的是关掉推理 / 思考，
// 例如 {"enable_thinking":false} 或 {"thinking":{"type":"disabled"}}（参数名以所用接口的文档为准）
function extraBody(raw) {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === 'object' && !Array.isArray(o)) return o
  } catch (e) { /* 走下面的报错 */ }
  throw new Error('AI_EXTRA_BODY 不是合法的 JSON 对象')
}

function callLLM(system, text, opts) {
  const env = process.env
  const provider = (env.AI_PROVIDER || 'openai').toLowerCase()
  if (!env.AI_API_KEY || !env.AI_MODEL) throw new Error('未配置 AI_API_KEY / AI_MODEL')
  const timeout = opts.timeout
  const maxTokens = Number(env.AI_MAX_TOKENS) || opts.maxTokens // 推理类模型的思考过程也算 token，不够用时可在环境变量里调大
  const extra = extraBody(env.AI_EXTRA_BODY)

  if (provider === 'anthropic') {
    const base = (env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')
    return postJSON(base + '/v1/messages', {
      'x-api-key': env.AI_API_KEY,
      'anthropic-version': '2023-06-01'
    }, Object.assign({
      model: env.AI_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: text }]
    }, extra), timeout).then(r => {
      const via = trace(base, r)
      const block = (r.content || []).find(b => b.type === 'text')
      if (!block || !block.text) throw new Error('模型没有返回内容（stop_reason=' + r.stop_reason + '；' + via + '）')
      return block.text
    })
  }

  if (!env.AI_BASE_URL) throw new Error('openai 模式需要配置 AI_BASE_URL')
  const base = env.AI_BASE_URL.replace(/\/+$/, '')
  return postJSON(base + '/chat/completions', { Authorization: 'Bearer ' + env.AI_API_KEY }, Object.assign({
    model: env.AI_MODEL,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: 'system', content: system }, { role: 'user', content: text }]
  }, extra), timeout).then(r => {
    const via = trace(base, r)
    const choice = (r.choices && r.choices[0]) || {}
    const msg = choice.message || {}
    // content 通常是字符串，个别接口返回 [{ type: 'text', text }] 分段
    const text = Array.isArray(msg.content) ? msg.content.map(p => (p && p.text) || '').join('') : String(msg.content || '')
    if (!text.trim()) {
      throw new Error('模型没有返回内容（finish_reason=' + choice.finish_reason +
        (msg.reasoning_content ? '，只返回了推理过程：请换非推理模型，或把 AI_MAX_TOKENS 调大' : '') + '；' + via + '）')
    }
    return text
  })
}

// 模型偶尔会带上 ```json 围栏或多余文字：优先取第一个 { 到最后一个 }，失败再试 [ 到 ]
function extractJSON(raw) {
  const s = String(raw || '')
  const tryParse = (open, close) => {
    const i = s.indexOf(open)
    const j = s.lastIndexOf(close)
    if (i < 0 || j <= i) return undefined
    try { return JSON.parse(s.slice(i, j + 1)) } catch (e) { return undefined }
  }
  const o = tryParse('{', '}')
  if (o !== undefined) return o
  const a = tryParse('[', ']')
  if (a !== undefined) return a
  throw new Error('模型未返回 JSON：' + s.slice(0, 150).replace(/\s+/g, ' ')) // 带上原文开头，日志里一眼能看出模型到底回了什么
}

// 兼容三种回答：{items:[…]} / […] / 旧版的单个对象
function toItems(o) {
  const arr = Array.isArray(o) ? o : (o && Array.isArray(o.items) ? o.items : [o])
  const items = arr.filter(x => x && typeof x === 'object').slice(0, MAX_ITEMS)
  if (!items.length) throw new Error('模型未返回账单')
  return items.map(x => ({
    type: x.type, catId: x.catId, sub: x.sub, amount: x.amount, date: x.date, remark: x.remark,
    accountId: x.accountId, toAccountId: x.toAccountId, reimburse: x.reimburse, tag: x.tag
  }))
}

// ---------------------------------------------------------------- 批量分类（Excel 导入）
// 校验行：形状不对就整体拒绝，字段按长度截断
function checkRows(rows, tax) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) throw new Error('rows 数量不正确')
  return rows.map(r => {
    if (!r || !Number.isInteger(r.i) || r.i < 0 || !tax[r.type] || (r.type !== 'expense' && r.type !== 'income')) {
      throw new Error('rows 格式不正确')
    }
    return { i: r.i, type: r.type, desc: String(r.desc || '').slice(0, 80), hint: String(r.hint || '').slice(0, 30) }
  })
}

function buildRowsPrompt(tax) {
  return [
    '你是记账分类助手。输入是从 Excel 账单读出的若干行流水（JSON 数组），每行有：',
    'i（行序号）、type（expense 支出 / income 收入，已经确定，不要改）、desc（交易对方、商品、备注拼成的文字）、',
    'hint（原表里的分类，可能为空，只供参考，不一定准确）。',
    '为每一行选出最贴切的分类，并整理一个简短备注。只输出一个 JSON 对象，不要任何解释或代码块标记：',
    '{"items":[{"i":0,"catId":"","sub":"","remark":""}]}',
    '',
    '【分类】可选分类如下，格式「catId=名称(子分类/子分类)」，catId、sub 必须严格从该行 type 对应的列表里选：',
    taxonomyLines(tax),
    'sub 要选最贴切的子分类，没有合适的就输出空字符串。实在无法判断时 catId=other，sub 为空字符串。',
    '餐饮尽量细分：能看出是外卖平台（美团外卖、饿了么）选「外卖」，奶茶咖啡（瑞幸、星巴克、喜茶）选「饮品」，',
    '水果零食便利店选「零食水果」；看不出是哪一餐、也不是以上几类时 sub 留空，不要乱猜早餐 / 午餐 / 晚餐。',
    '',
    '【备注】remark 只写商户或事项本身的简短名称（不超过 15 个字），例如「星巴克」「滴滴出行」「房租」。',
    '去掉订单号、流水号、分店 / 地名后缀、金额和日期。desc 里没有有效信息时 remark 输出空字符串。',
    '',
    'items 必须与输入逐行对应：每个 i 恰好一项，不要遗漏、不要新增。'
  ].join('\n')
}

function toRowItems(o, rows) {
  const arr = Array.isArray(o) ? o : (o && Array.isArray(o.items) ? o.items : [])
  const valid = {}
  rows.forEach(r => { valid[r.i] = true })
  return arr
    .filter(x => x && valid[x.i])
    .map(x => ({ i: x.i, catId: String(x.catId || ''), sub: String(x.sub || ''), remark: String(x.remark || '').slice(0, 50) }))
}

exports.main = async (event, context) => {
  if (event && event.rows !== undefined) {
    const tax = checkTaxonomy(event.taxonomy)
    const rows = checkRows(event.rows, tax)
    const raw = await callLLM(buildRowsPrompt(tax), JSON.stringify(rows), { maxTokens: 6800, timeout: llmBudget(context, 30000) })
    return { items: toRowItems(extractJSON(raw), rows) }
  }
  const text = String((event && event.text) || '').trim().slice(0, MAX_TEXT)
  if (!text) throw new Error('内容为空')
  const tax = checkTaxonomy(event && event.taxonomy)
  const ctx = checkContext(event && event.context)
  return { items: toItems(extractJSON(await callLLM(buildSystemPrompt(tax, ctx), text, { maxTokens: 3600, timeout: llmBudget(context, 15000) }))) }
}
