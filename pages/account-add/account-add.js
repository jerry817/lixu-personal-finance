// pages/account-add/account-add.js 添加账户：先选分类（图2），再进入账户表单（图3）
const kinds = require('../../utils/accountKinds')

Page({
  data: {
    groups: kinds.GROUPS.map(g => ({
      key: g.key,
      label: g.label,
      kinds: g.kinds.map(k => ({
        key: k.key, label: k.label, icon: k.icon,
        long: k.label.length > 5 // 「应付款/借入」等长标签缩小字号，避免相邻两项互相压住
      }))
    }))
  },

  pick(e) {
    const { g, k } = e.currentTarget.dataset
    wx.navigateTo({ url: '/pages/account-edit/account-edit?group=' + g + '&kind=' + k })
  }
})
