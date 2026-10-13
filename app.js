// app.js
const store = require('./utils/store')
const cloud = require('./utils/cloud')
const privacy = require('./utils/privacy')

App({
  globalData: {
    userInfo: null,
    openid: '',
    openLogin: false,   // 一次性标记：未登录点了云 / AI 功能，「我的」页显示时自动弹出登录弹层（utils/auth.js）
    privacyTick: false, // 一次性标记：在隐私协议页点了「我已阅读并同意」，「我的」页据此勾选登录弹层里的同意框
    exportIds: null,    // 一次性交接：精准导出在搜索页选中的账单 id，导出页读取后清空（packages/excel）
    bookName: '厘序记账'
  },

  onLaunch() {
    // 登录态与隐私协议绑定：没同意过当前版本协议的旧登录态（老版本升级上来的、或协议改版后）一律退出，
    // 需要重新阅读并同意后再登录。退出登录不会清本机账单，用户数据不受影响
    if (cloud.isLoggedIn() && !privacy.hasAgreed()) cloud.logout()
    // 初始化微信云开发：用户同意隐私协议之后才会真正初始化（未同意时什么都不做，详见 utils/cloud.js）
    cloud.initCloud()
    // 清理旧版演示数据并保证默认账户存在（不再写入任何演示账单/预算）
    store.initDefaults()
    // 已登录：恢复登录态；本机账本还没有归属时认领给当前账号（旧版本遗留的数据）。
    // 云端拉取交给 onShow 里的实时同步（启动后紧接着就会触发一次）
    cloud.restoreSession()
    if (cloud.isLoggedIn() && !store.getLedgerOwner()) store.claimLedger(cloud.getOpenid())
    // 同步拉回其它设备的改动后，让当前页面重新读取本地数据（页面实现 onDataChanged；正在编辑的页面不实现，不会被打断）
    store.onRemoteChange(() => this.notifyDataChanged())
  },

  // 前台期间保持多端实时同步（监听 + 轮询兜底），退到后台就停掉，详见 store.startLiveSync
  onShow() {
    store.startLiveSync()
  },

  onHide() {
    store.stopLiveSync()
  },

  // 云端数据同步到本机后，通知栈顶页面刷新
  notifyDataChanged() {
    const pages = getCurrentPages()
    const top = pages[pages.length - 1]
    if (top && typeof top.onDataChanged === 'function') top.onDataChanged()
  },

  // 后台同步完成后让当前页面重新读一次本地数据
  refreshTopPage() {
    const pages = getCurrentPages()
    const top = pages[pages.length - 1]
    if (top && typeof top.onShow === 'function') top.onShow()
  }
})
