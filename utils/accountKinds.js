// utils/accountKinds.js 账户分类目录（纯数据 + 纯函数，不碰存储）
// 「添加账户」页按 GROUPS 渲染分组网格；账户编辑页用它推导 type（余额/净资产口径依赖 type）。
//
// 账户记录在原有字段上新增：group（所属分组）、kind（具体品类）、alias（简称）、remark、cardNo、
// inTotal（是否计入总资产，默认 true）、currency。老账户没有这些字段，用 groupOf/kindOf 按 type 推导。
//
// 定期存款不是账户品类，不在这份分类目录里：入口在账户详情页右上角「⋮」二级菜单（pages/account-detail），
// 另有账户页「定期存款」卡片，二者指向同一份定存记录（pages/deposit-list）。

const ACC = '/images/acc/'

// type 沿用旧口径：cash | wechat | alipay | bank | credit | invest | other
//   credit  → 计入「总负债」（余额为负的部分）
//   其余    → 计入「总资产」
const GROUPS = [
  { key: 'fund', label: '资金账户', type: 'other', kinds: [
    { key: 'cash', label: '现金', type: 'cash', icon: ACC + 'acc_cash.png' },
    { key: 'alipay', label: '支付宝', type: 'alipay', icon: ACC + 'acc_alipay.png' },
    { key: 'wechat', label: '微信钱包', type: 'wechat', icon: ACC + 'acc_wechat.png' },
    { key: 'bank', label: '银行卡', type: 'bank', icon: ACC + 'acc_bank.png' },
    { key: 'qq', label: 'QQ钱包', icon: ACC + 'k_qq.png' },
    { key: 'jd', label: '京东金融', icon: ACC + 'k_jd.png' },
    { key: 'custom', label: '自定义', icon: ACC + 'k_custom.png' }
  ] },
  { key: 'credit', label: '信贷账户', type: 'credit', kinds: [
    { key: 'credit', label: '信用卡', icon: ACC + 'acc_credit.png' },
    { key: 'huabei', label: '花呗', icon: ACC + 'k_huabei.png' },
    { key: 'baitiao', label: '白条', icon: ACC + 'k_baitiao.png' },
    { key: 'custom', label: '自定义', icon: ACC + 'k_custom.png' }
  ] },
  { key: 'prepaid', label: '充值账户', type: 'other', kinds: [
    { key: 'member', label: '会员卡', icon: ACC + 'k_member.png' },
    { key: 'bus', label: '公交卡', icon: ACC + 'k_bus.png' },
    { key: 'meal', label: '饭卡', icon: ACC + 'k_meal.png' },
    { key: 'deposit', label: '押金', icon: ACC + 'k_deposit.png' },
    { key: 'custom', label: '自定义', icon: ACC + 'k_custom.png' }
  ] },
  { key: 'invest', label: '投资理财', type: 'invest', kinds: [
    { key: 'insure', label: '保险', icon: ACC + 'k_insure.png' },
    { key: 'crypto', label: '虚拟货币', icon: ACC + 'k_crypto.png' },
    { key: 'custom', label: '自定义', icon: ACC + 'k_custom.png' }
  ] },
  { key: 'goods', label: '二手货物', type: 'other', kinds: [
    { key: 'house', label: '房子', icon: ACC + 'k_house.png' },
    { key: 'car', label: '车子', icon: ACC + 'k_car.png' },
    { key: 'custom', label: '自定义', icon: ACC + 'k_custom.png' }
  ] },
  { key: 'debt', label: '债务', type: 'other', kinds: [
    { key: 'payable', label: '应付/借入', icon: ACC + 'k_payable.png' },
    { key: 'receivable', label: '应收/借出', icon: ACC + 'k_receivable.png' },
    { key: 'reimburse', label: '报销账户', icon: ACC + 'k_reimburse.png' },
    { key: 'custom', label: '自定义', icon: ACC + 'k_custom.png' }
  ] }
]

const GROUP_BY_KEY = {}
GROUPS.forEach(g => { GROUP_BY_KEY[g.key] = g })

function getGroup(key) {
  return GROUP_BY_KEY[key] || GROUP_BY_KEY.fund
}

function getKind(groupKey, kindKey) {
  const g = getGroup(groupKey)
  return g.kinds.find(k => k.key === kindKey) || g.kinds[g.kinds.length - 1]
}

// 老账户（只有 type）→ 所属分组
function groupOf(acc) {
  if (acc && acc.group && GROUP_BY_KEY[acc.group]) return acc.group
  if (acc && acc.type === 'credit') return 'credit'
  if (acc && acc.type === 'invest') return 'invest'
  return 'fund'
}

// 由分组 + 品类推导 type：
//   - 品类自带 type（现金/微信/支付宝/银行卡）且仍在其原生分组 → 用它（AI 记账的账户别名匹配依赖这些 type）
//   - 否则按分组默认：信贷 → credit，投资 → invest，其余 → other
function typeOf(groupKey, kindKey) {
  const g = getGroup(groupKey)
  const k = g.kinds.find(x => x.key === kindKey)
  return (k && k.type) || g.type
}

// 可选图标：去重后的全部品类图标（「账户图标」选择器用）
function allIcons() {
  const seen = {}
  const out = []
  GROUPS.forEach(g => g.kinds.forEach(k => {
    if (!seen[k.icon]) { seen[k.icon] = 1; out.push(k.icon) }
  }))
  return out
}

module.exports = { GROUPS, getGroup, getKind, groupOf, typeOf, allIcons }
