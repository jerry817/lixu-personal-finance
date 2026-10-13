// utils/auth.js
/**
 * 云功能 / AI 功能的登录门禁
 *
 * 云功能（云同步、云端附件）和 AI 功能（AI 智能记账、Excel 导入的 AI 分类）必须登录后才能用。
 * 未登录时：
 *   · 入口处调用 requireLogin(feature)，弹窗提示并可一键跳到「我的」页的登录弹层；
 *   · 底层（cloud.callFn / ai.js）再各自拒绝一次，所以漏掉入口也不会发出云请求。
 * 记账、查看账单、统计等本地功能不受影响，数据只读写本机缓存。
 */
const cloud = require('./cloud')

const PROFILE_TAB = '/pages/profile/profile'

// 已登录返回 true；未登录弹窗提示并返回 false。feature 是功能名，如「AI 智能记账」
function requireLogin(feature) {
  if (cloud.isLoggedIn()) return true
  wx.showModal({
    title: '需要登录',
    content: (feature || '该功能') + '需要先登录。登录后即可使用云功能；不登录时账单保存在本地。',
    confirmText: '去登录',
    cancelText: '暂不登录',
    success(res) {
      if (res.confirm) goLogin()
    }
  })
  return false
}

// 跳到「我的」页并自动弹出登录弹层（弹层里需要阅读并同意隐私协议）
function goLogin() {
  const app = getApp()
  if (app && app.globalData) app.globalData.openLogin = true
  const pages = getCurrentPages()
  const top = pages[pages.length - 1]
  if (top && top.route === 'pages/profile/profile') {
    if (typeof top.onShow === 'function') top.onShow()
    return
  }
  wx.switchTab({ url: PROFILE_TAB })
}

module.exports = { requireLogin, goLogin }
