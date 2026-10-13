// pages/profile/profile.js
const util = require('../../utils/util')
const store = require('../../utils/store')
const cloud = require('../../utils/cloud')
const privacy = require('../../utils/privacy')

const FEEDBACK_EMAIL = 'tom817@126.com'

Page({
  data: {
    avatar: '',
    nick: '',
    days: 0,
    count: 0,
    cloudReady: false,
    syncing: false,
    loggedIn: false,
    openid: '',      // 完整 openid：仅用于复制
    openidShort: '', // 卡片上展示的打码版本，保证单行显示
    lastUploadText: '',
    loginShow: false,
    agreed: false,   // 登录弹层里「已阅读并同意《用户隐私协议》」是否勾选（每次登录都要勾选）
    tmpAvatar: '',
    tmpNick: '',
    feedbackShow: false, // 建议反馈弹窗（开发者邮箱）
    email: FEEDBACK_EMAIL,

    features: [
      { icon: '/images/ui/tag.png', label: '标签管理', url: '/pages/tags/tags' },
      { icon: '/images/ui/grid.png', label: '分类管理', url: '/pages/category/category' },
      { icon: '/images/ui/m_tpl.png', label: '模板记账', url: '/pages/templates/templates' }
    ],
    dataTools: [
      { icon: '/images/ui/cloud.png', label: '云同步', act: 'sync', needLogin: true },
      { icon: '/images/ui/exchange.png', label: '导入 / 导出', act: 'port' }
    ],
    others: [
      { icon: '/images/ui/guide.png', label: '使用手册', url: '/pages/about/about?t=guide' },
      { icon: '/images/ui/feedback.png', label: '建议反馈', act: 'feedback' },
      { icon: '/images/ui/info.png', label: '关于我们', url: '/pages/about/about?t=about' },
      { icon: '/images/ui/key.png', label: '用户隐私协议', url: '/pages/privacy/privacy' }
    ]
  },

  onShow() {
    const loggedIn = cloud.isLoggedIn()
    // 已登录但没设置头像/昵称：用默认头像 + 随机昵称兜底（只补空缺，不覆盖用户自己设置的）
    const u = loggedIn ? store.ensureUserProfile() : store.getUser()
    const s = store.userStats()
    const ts = cloud.getLastUploadTime()
    this.setData({
      avatar: u.avatar,
      nick: u.nick,
      days: s.days,
      count: s.count,
      cloudReady: cloud.ready(),
      loggedIn,
      openid: cloud.getOpenid(),
      openidShort: util.maskId(cloud.getOpenid()),
      lastUploadText: ts ? util.fullTime(ts) : '暂无上传记录'
    })
    this.consumeGlobalFlags(loggedIn)
  },

  // 其它设备的改动同步到本机后由 App 调用：账单数 / 记账天数跟着更新
  onDataChanged() { this.onShow() },

  // 其它页面通过 globalData 传来的两个一次性标记：
  //   openLogin    未登录时点了云 / AI 功能 → 跳到本页后自动弹出登录弹层（utils/auth.js）
  //   privacyTick  在隐私协议页点了「我已阅读并同意」→ 回到本页后勾选弹层里的同意框
  consumeGlobalFlags(loggedIn) {
    const g = getApp().globalData
    if (g.privacyTick) {
      g.privacyTick = false
      this.setData({ agreed: true })
    }
    if (g.openLogin) {
      g.openLogin = false
      if (!loggedIn && !this.data.loginShow) this.openLogin()
    }
  },

  noop() {},

  copyOpenid() {
    const openid = this.data.openid
    if (!openid) return
    // 复制的始终是完整 openid，而不是卡片上打码后的文本
    wx.setClipboardData({ data: openid })
  },

  // 头像文件失效（如临时文件被回收）时退回默认头像
  onAvatarError() {
    if (this.data.avatar === store.DEFAULT_AVATAR) return
    store.setUser({ avatar: store.DEFAULT_AVATAR })
    this.setData({ avatar: store.DEFAULT_AVATAR })
  },

  // ------------------------------------------------ 登录弹层（头像昵称与登录合一）
  openLogin() {
    if (!this.cloudEnabled()) return
    this.setData({ loginShow: true, agreed: false, tmpAvatar: this.data.avatar, tmpNick: this.data.nick })
  },

  // 勾选 / 取消「已阅读并同意」
  toggleAgree() {
    this.setData({ agreed: !this.data.agreed })
  },

  // 打开隐私协议全文；从登录弹层进入时页底有「我已阅读并同意」，点了回到这里并自动勾选
  openPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy?from=login' })
  },

  closeLogin() {
    if (this.data.syncing) return
    this.setData({ loginShow: false })
  },

  onTmpAvatar(e) {
    this.setData({ tmpAvatar: e.detail.avatarUrl })
  },

  onTmpNick(e) {
    this.setData({ tmpNick: e.detail.value })
  },

  // 云开发未配置时提示并返回 false（只看开发者是否配好环境；用户还没同意协议不算「未启用」，同意发生在登录弹层里）
  cloudEnabled() {
    if (cloud.configured()) return true
    wx.showModal({
      title: '云同步未启用',
      content: '请在微信开发者工具中开通云开发，并将环境 ID 填入 utils/cloud.js 的 CLOUD_ENV。',
      showCancel: false
    })
    return false
  },

  // 云操作统一外壳：防重入 → 转圈 → 失败统一提示 → 解锁；成功的提示与后续由 onOk 决定
  runCloud(loading, task, onOk, failMsg) {
    if (this.data.syncing || !this.cloudEnabled()) return
    this.setData({ syncing: true })
    wx.showLoading({ title: loading })
    Promise.resolve().then(task).then(r => {
      wx.hideLoading()
      onOk(r)
      this.onShow()
    }).catch(err => {
      wx.hideLoading()
      this.onShow()
      if (err && err.cancelled) return // 用户主动取消（如不愿清掉另一个账号的本机数据），不提示失败
      wx.showToast({ title: failMsg, icon: 'none' })
      console.warn('[cloud]', failMsg, err)
    }).then(() => this.setData({ syncing: false }))
  },

  // ------------------------------------------------ 登录 / 退出
  // 登录：只等账号认证（wx.login → 云函数换 openid → 处理本机账本归属），认证完成立即关闭转圈和弹层；
  // 云端数据的拉取 / 上传放到后台（backgroundSync），不再让「登录中...」等着整个同步跑完。
  // prepare 是登录前要先做的事（如保存头像昵称）
  login(prepare) {
    this.runCloud('登录中...',
      () => Promise.resolve(prepare && prepare())
        .then(() => cloud.login())
        .then(r => this.adoptLedger(r.openid)),
      () => {
        wx.showToast({ title: '登录成功', icon: 'success' })
        this.setData({ loginShow: false })
        this.backgroundSync()
      }, '登录失败')
  },

  // 登录后的首次完整同步（含登录前 / 退出登录期间记的账）：后台进行，不加锁、不转圈；
  // 完成后刷新当前页面，失败只提示一句，可稍后点「云同步」重试
  backgroundSync() {
    store.startLiveSync({ kick: false }) // 登录后进入多端实时同步（监听 + 轮询）；首次同步就是下面这一次，不再多排一次
    store.syncAll().then(() => getApp().refreshTopPage()).catch(err => {
      console.warn('[login sync]', err)
      wx.showToast({ title: '云端同步失败，可稍后点「云同步」重试', icon: 'none' })
    })
  },

  // 登录成功后处理本机账本的归属（防串号，见 store 的「本机账本归属」）：
  //   · 没有归属（游客账本 / 首次登录）或就是本账号 → 认领，登录期间的账稍后一起同步上云；
  //   · 属于另一个账号 → 不能直接合并（会把别人的账单传进这个账号的云端），让用户选：
  //     清空本机数据后登录，或取消登录（退回未登录，本机数据原样保留）。
  adoptLedger(openid) {
    if (!store.ledgerOwnedByOther(openid)) {
      store.claimLedger(openid)
      return
    }
    wx.hideLoading()
    return new Promise((resolve, reject) => {
      wx.showModal({
        title: '本地数据属于另一个账号',
        content: '本地保存的账单来自之前登录的另一个账号。继续登录将清空本地缓存，并载入当前账号的云端数据（之前登录账号的云端数据不受影响）。',
        confirmText: '清空并登录',
        cancelText: '取消登录',
        confirmColor: '#F25350',
        success: (res) => {
          if (res.confirm) {
            wx.showLoading({ title: '登录中...' })
            store.clearLocalLedger()
            store.claimLedger(openid)
            resolve()
          } else {
            cloud.logout()
            const err = new Error('login-cancelled')
            err.cancelled = true
            reject(err)
          }
        },
        fail: () => {
          cloud.logout()
          const err = new Error('login-cancelled')
          err.cancelled = true
          reject(err)
        }
      })
    })
  },

  // 登录弹层「一键登录」：必须先勾选同意隐私协议；先保存头像昵称（没填则存空值，登录后 onShow 会补默认头像与随机昵称）
  confirmLogin() {
    if (this.data.syncing) return
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意用户隐私协议', icon: 'none' })
      return
    }
    privacy.agree() // 同意记录在本机；同意之后才会初始化云开发
    cloud.initCloud()
    this.login(() => store.saveAvatar(this.data.tmpAvatar)
      .then(avatar => store.setUser({ avatar, nick: String(this.data.tmpNick || '').trim() })))
  },

  doLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后将无法使用云功能。本地已有的数据会继续保留，之后产生的数据只保存在本地，直至主动清空本地缓存。重新登录后会自动同步云端。',
      confirmText: '退出登录',
      confirmColor: '#F25350',
      success: (res) => {
        if (!res.confirm) return
        store.stopLiveSync() // 先停实时同步，再清登录态
        cloud.logout() // 只清登录态，本机账本数据不动
        wx.showToast({ title: '已退出登录', icon: 'none' })
        this.onShow()
      }
    })
  },

  onChooseAvatar(e) {
    store.saveAvatar(e.detail.avatarUrl).then(url => {
      store.setUser({ avatar: url })
      this.setData({ avatar: url })
    })
  },

  onNick(e) {
    const v = String(e.detail.value || '').trim()
    store.setUser({ nick: v })
    // 清空昵称时回退到随机昵称，避免卡片上出现空白
    this.setData({ nick: store.ensureUserProfile().nick })
  },

  goPage(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.navigateTo({ url })
  },

  // 「其他」里的入口：有 act 的在本页弹窗处理，其余跳页
  tapOther(e) {
    if (e.currentTarget.dataset.act === 'feedback') this.setData({ feedbackShow: true })
    else this.goPage(e)
  },

  // ------------------------------------------------ 建议反馈弹窗（本页内，不跳转）
  closeFeedback() { this.setData({ feedbackShow: false }) },

  copyEmail() { wx.setClipboardData({ data: FEEDBACK_EMAIL }) },

  // ------------------------------------------------ 云同步
  tapDataTool(e) {
    if (e.currentTarget.dataset.act === 'sync') this.cloudSync()
    else this.importExport()
  },

  cloudSync() {
    if (this.data.syncing) return
    // 云同步是登录后的功能：未登录打开登录弹层（需阅读并同意隐私协议），不直接登录
    if (!cloud.isLoggedIn()) { this.openLogin(); return }
    this.runCloud('同步中...', () => store.syncAll(), r => {
      const bad = r.failed + (r.attachFailed || 0)
      let msg = '已同步 ' + r.total + ' 笔'
      if (r.failed) msg = '已同步，' + r.failed + ' 笔上传失败'
      else if (r.attachFailed) msg = '已同步，' + r.attachFailed + ' 个附件上传失败'
      wx.showToast({ title: msg, icon: bad ? 'none' : 'success' })
    }, '同步失败')
  },

  // ------------------------------------------------ 导入 / 导出
  importExport() {
    wx.showActionSheet({
      itemList: ['Excel 导入 / 导出', '导出账单（复制 JSON 到剪贴板）', '导入账单（从剪贴板 JSON）'],
      success: (res) => {
        if (res.tapIndex === 0) wx.navigateTo({ url: '/packages/excel/pages/excel/excel' })
        else if (res.tapIndex === 1) this.doExport()
        else this.doImport()
      }
    })
  },

  doExport() {
    const data = {
      app: 'daily-bill',
      time: util.fullTime(Date.now()),
      bills: store.getBillsSync()
    }
    wx.setClipboardData({
      data: JSON.stringify(data),
      success() {
        wx.showModal({
          title: '导出完成',
          content: '账单已复制为 JSON，可粘贴保存到备忘录或发送给好友。',
          showCancel: false
        })
      }
    })
  },

  doImport() {
    wx.getClipboardData({
      success: (res) => {
        try {
          const obj = JSON.parse(res.data)
          const bills = Array.isArray(obj) ? obj : obj.bills
          if (!Array.isArray(bills)) throw new Error('格式不符')
          const r = store.mergeBills(bills)
          this.onShow()
          wx.showToast({ title: '导入成功，新增' + r.added + '笔', icon: 'success' })
        } catch (e) {
          wx.showToast({ title: '剪贴板中无有效账单', icon: 'none' })
        }
      }
    })
  },

  // ------------------------------------------------ 重置
  resetData() {
    const loggedIn = cloud.isLoggedIn()
    const pending = loggedIn ? store.pendingSyncInfo() : { bills: 0, meta: false }
    let tip = loggedIn ? '云端数据不受影响，清空后会立即从云端恢复。' : '你当前未登录，没有云端备份，清空后无法找回。'
    if (pending.bills || pending.meta) {
      const what = [pending.bills ? pending.bills + ' 笔账单的新增 / 修改 / 删除' : '', pending.meta ? '账户 / 预算设置的修改' : ''].filter(Boolean).join('、')
      tip += '\n\n注意：' + what + '还没有同步到云端，清空后这部分会丢失。建议先点「云同步」。'
    }
    wx.showModal({
      title: '确认清空本地全部缓存？',
      content: '将删除本地的全部账单、账户、预算等数据，无法恢复。' + tip,
      confirmText: '清空',
      confirmColor: '#F25350',
      success: (m) => {
        if (!m.confirm) return
        store.clearLocalLedger()
        if (!loggedIn) {
          wx.showToast({ title: '已清空', icon: 'success' })
          this.onShow()
          return
        }
        store.claimLedger(cloud.getOpenid()) // 清的是本账号的缓存，归属不变
        // 云端才是数据的准确来源：不等下一次轮询，立刻重新全量拉取（本机进度已作废），期间用加载提示盖住空白页面
        wx.showLoading({ title: '清空并从云端恢复中...', mask: true })
        store.syncFresh().then(
          () => { wx.hideLoading(); wx.showToast({ title: '已清空，云端数据已恢复', icon: 'success' }) },
          err => {
            console.warn('[reset] restore', err)
            wx.hideLoading()
            wx.showToast({ title: '已清空，但云端恢复失败，请点「云同步」重试', icon: 'none' })
          }
        ).then(() => getApp().refreshTopPage())
      }
    })
  }
})
