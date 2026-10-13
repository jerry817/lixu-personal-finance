// utils/categories.js 记账类型、分类、账户配置
// 图标位于 /images/cat，普通态深色，选中态 _on 白色

const TYPES = [
  { key: 'expense', label: '支出' },
  { key: 'income', label: '收入' },
  { key: 'transfer', label: '转账' },
  { key: 'debt', label: '债务' }
]

// 支出（顺序即记账页网格顺序，5 列布局；食品餐饮最前，其他最后）
const EXPENSE = [
  { id: 'food', icon: 'o_food', label: '食品餐饮',
    subs: ['早餐', '午餐', '晚餐', '夜宵', '外卖', '零食水果', '饮品'] },
  { id: 'shopping', icon: 'o_shop', label: '购物消费',
    subs: ['日用百货', '服饰鞋包', '数码电器', '护肤美妆'] },
  { id: 'transport', icon: 'o_trans', label: '出行交通',
    subs: ['公交地铁', '打车', '加油', '火车机票'] },
  { id: 'fun', icon: 'o_fun', label: '休闲娱乐',
    subs: ['电影演出', '游戏', '旅游度假', '运动健身'] },
  { id: 'home', icon: 'o_home', label: '居家生活',
    subs: ['话费宽带', '水电燃气', '房租物业', '生活用品'] },
  { id: 'edu', icon: 'o_edu', label: '文化教育',
    subs: ['书籍', '培训课程', '学费'] },
  { id: 'gift', icon: 'o_gift', label: '送礼人情',
    subs: ['红包', '礼物', '请客'] },
  { id: 'medical', icon: 'o_med', label: '健康医疗',
    subs: ['药品', '门诊', '体检', '保健'] },
  { id: 'other', icon: 'o_other', label: '其他',
    subs: ['理发', '罚款赔偿', '理财支出', '慈善捐助'] }
]

// 收入
const INCOME = [
  { id: 'salary', icon: 'i_salary', label: '工资', subs: ['基本工资', '加班补贴'] },
  { id: 'part', icon: 'i_part', label: '兼职外快', subs: [] },
  { id: 'bonus', icon: 'i_bonus', label: '奖金', subs: [] },
  { id: 'invest', icon: 'i_invest', label: '投资理财', subs: ['利息', '基金股票'] },
  { id: 'red', icon: 'i_red', label: '红包', subs: [] },
  { id: 'refund', icon: 'i_refund', label: '退款', subs: [] },
  { id: 'other', icon: 'i_other', label: '其他收入', subs: [] }
]

// 转账
const TRANSFER = [
  { id: 'transfer', icon: 't_transfer', label: '转账', subs: [] }
]

// 债务
const DEBT = [
  { id: 'borrow', icon: 'd_borrow', label: '借入', subs: [] },
  { id: 'lend', icon: 'd_lend', label: '借出', subs: [] }
]

// 债务账户上的「还款（应付款）/ 收款（应收款）」：只在账单里引用，用来取名称 / 图标，
// 不放进 DEBT，因此不会出现在分类管理里。图标沿用资金流向相同的借出 / 借入图标（还款=钱流出，收款=钱流入）
const DEBT_EXTRA = [
  { id: 'repay', icon: 'd_lend', label: '还款', subs: [] },
  { id: 'collect', icon: 'd_borrow', label: '收款', subs: [] }
]

// 注意：支出与收入均含 id='other'，必须按类型分别建索引，否则互相覆盖
const MAPS = { expense: {}, income: {}, transfer: {}, debt: {} }
function fill(type, list) { list.forEach(c => { MAPS[type][c.id] = c }) }
fill('expense', EXPENSE)
fill('income', INCOME)
fill('transfer', TRANSFER)
fill('debt', DEBT)
fill('debt', DEBT_EXTRA)
const GLOBAL_MAP = Object.assign({}, MAPS.expense, MAPS.income, MAPS.transfer, MAPS.debt)

function getCats(type) {
  return { expense: EXPENSE, income: INCOME, transfer: TRANSFER, debt: DEBT }[type] || []
}

// type 已知时优先在对应类型中查找，避免支出/收入同名 id 取错
function getCat(id, type) {
  if (type && MAPS[type] && MAPS[type][id]) return MAPS[type][id]
  return GLOBAL_MAP[id]
}

function iconPath(icon, on) {
  return '/images/cat/' + icon + (on ? '_on' : '') + '.png'
}

module.exports = {
  TYPES, EXPENSE, INCOME, TRANSFER, DEBT,
  getCats, getCat, iconPath
}
