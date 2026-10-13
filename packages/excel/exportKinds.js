// packages/excel/exportKinds.js 导出入口清单：Excel 页的入口列表与导出页共用（标题 / 说明 / 文件名只写这一处）
//   bill     账单导出：全部账单（含转账、债务），想整本备份用它
//   transfer 转账还款导出：转账账单（信用卡还款在本应用里就是转入信用账户的转账）
//   debt     债务导出：借入 / 借出 / 还款 / 收款，另附债务账户当前待还 / 待收
//   deposit  理财导出：定期存款
//   每项的 book 是导出页「账本」名（概览标题 + 账本行），与导出范围一致：全部账本 / 全部转账 / 全部债务 / 全部理财 / 手选账单
//   picked   精准导出：在搜索页长按手选账单（入口在搜索页，见 pages/search）
module.exports = [
  { kind: 'bill', title: '全部账单导出', desc: '将本地的账单数据导出到 Excel', file: '账单', book: '全部账本' },
  { kind: 'transfer', title: '转账还款导出', desc: '将本地的转账还款数据导出到 Excel', file: '转账还款', book: '全部转账' },
  { kind: 'debt', title: '债务导出', desc: '将本地的债务数据导出到 Excel', file: '债务', book: '全部债务' },
  { kind: 'deposit', title: '理财导出', desc: '将本地的理财数据导出到 Excel', file: '理财', book: '全部理财' },
  { kind: 'picked', title: '精准导出', desc: '搜索相关账单，长按并选择账单进行导出', file: '精准账单', book: '手选账单' }
]
