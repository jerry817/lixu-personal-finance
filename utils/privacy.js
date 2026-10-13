// utils/privacy.js
/**
 * 用户隐私协议：同意记录（本机存储）
 *
 * - 登录前必须阅读并勾选同意；同意结果带协议版本号保存在本机，协议改版（升级 VERSION）后需要重新同意；
 * - 云开发（wx.cloud.init / 云函数 / 数据库 / 云存储）只在同意之后才会启用，见 utils/cloud.js；
 * - 本模块不依赖其它模块，避免与 cloud.js / store.js 循环引用。
 */
const VERSION = '2026-10-10' // 协议文本（pages/privacy/privacy.js）有实质改动时同步修改，用户会被要求重新同意
const K_CONSENT = 'privacy_consent'

function getConsent() {
  try {
    return wx.getStorageSync(K_CONSENT) || null
  } catch (e) {
    return null
  }
}

// 是否已同意当前版本的协议
function hasAgreed() {
  const c = getConsent()
  return !!c && c.version === VERSION
}

function agree() {
  wx.setStorageSync(K_CONSENT, { version: VERSION, time: Date.now() })
}

function revoke() {
  wx.removeStorageSync(K_CONSENT)
}

module.exports = { VERSION, getConsent, hasAgreed, agree, revoke }
