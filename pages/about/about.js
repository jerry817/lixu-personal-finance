// pages/about/about.js 关于我们 / 使用手册（入口见 pages/profile：?t=about|guide）
const TITLES = { about: '关于我们', guide: '使用手册' }

// 版本更新：新版本加在最前面；页头的版本号取第一条
const VERSIONS = [
  { v: 'v2.22', note: '账户 / 预算 / 模板的修改也会实时同步到其它设备；清空本地缓存后立即从云端恢复，并提示尚未同步的内容；编辑已在其他设备删除的账单时给出提示，不再悄悄丢失修改' },
  { v: 'v2.21', note: '多设备数据实时同步：一台设备记账 / 修改 / 删除后，其它设备无需手动刷新即可自动更新；模板与首页卡片设置也会跟随账号同步' },
  { v: 'v2.20', note: '修复进入报销账户看不到账单的问题' },
  { v: 'v2.19', note: '新增用户隐私协议；云功能需登录后使用；退出登录后本地账单照常保留，未登录期间账单存在本地，重新登录后自动同步' },
  { v: 'v2.18', note: '首页导航栏高度与其他页面一致；下拉添加账单的动画更跟手，修复轻微抖动' },
  { v: 'v2.17', note: '账单支持 Excel导入导出；导入时自动把流水归入详细分类，先预览再入账' },
  { v: 'v2.16', note: '定期存款：存入时校验可用余额，支持提前支取并填写已得收益' }
]

Page({
  data: {
    t: 'about',
    versions: VERSIONS
  },

  onLoad(options) {
    const t = TITLES[options.t] ? options.t : 'about'
    this.setData({ t })
    wx.setNavigationBarTitle({ title: TITLES[t] })
  }
})
