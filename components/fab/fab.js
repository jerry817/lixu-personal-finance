// components/fab 悬浮钮（ / 日历 / 账户页共用）
//
// · 随页面滚动淡出 / 淡入：页面在 onPageScroll 里调用 onScroll(scrollTop)；
// · ai=true：点击弹出 AI 智能记账弹窗并负责入账，入账后触发 saved，由页面刷新自己的列表；
// · ai=false：点击触发 press，由页面决定做什么。
const store = require('../../utils/store')
const ai = require('../../utils/ai')
const auth = require('../../utils/auth')

const FAB_DELTA = 8      // 同向累计滚动超过该像素才切换显隐
const FAB_TOP_ZONE = 20  // 距顶部不足该像素时始终显示

Component({
  properties: {
    ai: { type: Boolean, value: false },
    text: { type: String, value: '📝' }  // 悬浮钮上显示的文字 / emoji，各页可单独指定
  },

  data: {
    faded: false,    // 向下滚动淡出、向上滚动淡入
    aiVisible: false
  },

  pageLifetimes: {
    // 离开页面时若弹窗还开着（如跳转记账页）：立即关掉
    hide() { this.closeAI() }
  },

  methods: {
    // 同一方向累计滚动超过 FAB_DELTA 才切换（避免手指抖动来回闪烁）；回到顶部附近（含 iOS 回弹）始终显示。
    // 只在状态变化时 setData，滚动过程中不会频繁刷新视图。
    onScroll(top) {
      const last = this._last == null ? top : this._last
      this._last = top
      const dy = top - last
      if (top <= FAB_TOP_ZONE) {
        this._acc = 0
        this.setFaded(false)
        return
      }
      if (!dy) return
      // 方向改变则重新累计
      this._acc = (this._acc > 0) === (dy > 0) ? (this._acc || 0) + dy : dy
      if (this._acc > FAB_DELTA) this.setFaded(true)        // 向下滚动 → 淡出
      else if (this._acc < -FAB_DELTA) this.setFaded(false) // 向上滚动 → 淡入
    },

    setFaded(faded) {
      if (this.data.faded !== faded) this.setData({ faded })
    },

    // 已淡出（不可见）时不响应。
    // 位置用 CSS bottom（相对各页自己的窗口，窗口底已在 tabBar 之上）；不要用 wx.getWindowInfo 的高度算 top：
    // 它是（自定义导航栏）的窗口高度，日历 / 账户页有原生导航栏，算出来会偏低、压到 tabBar 上。
    // 弹窗本身不隐藏原生 tabBar（hideTabBar 会拉高页面窗口）；只有日历底部面板展开时才由 ai-sheet 收起、关闭后放回。
    onTap() {
      if (this.data.faded) return
      if (!this.data.ai) {
        this.triggerEvent('press')
        return
      }
      // AI 智能记账是登录后的功能：未登录弹窗引导去登录，不打开弹窗
      if (!auth.requireLogin('一笔记')) return
      if (!this.data.aiVisible) this.setData({ aiVisible: true })
    },

    closeAI() {
      if (this.data.aiVisible) this.setData({ aiVisible: false })
    },

    // 弹窗已完成识别并套用手动选择：入账 / 跳记账页；keep=长按 ✓，继续留在弹窗里记下一笔。
    // 一句话可能拆成多笔（早餐/午餐/晚餐各记各的）：信息完整的直接入账；
    // 缺金额（或转账缺账户）的带着已识别字段跳记账页补全。账户没说就是「无账户」，不默认微信
    onAIResult(e) {
      const { list, keep } = e.detail
      const ready = list.filter(ai.isComplete)
      const pending = list.filter(r => !ai.isComplete(r))
      if (!ready.length) {
        wx.navigateTo({ url: '/pages/add/add?' + ai.prefillQuery(pending[0]) })
        this.closeAI()
        return
      }
      ready.forEach(r => store.addBill(ai.toBill(r)))
      this.triggerEvent('saved')
      // 提示文案只看来源、不看笔数：AI → 「成功识别记账：x 笔」；本地模板 → 「已记账：x 笔（本地模板）」。
      // 一句话的来源通常一致；万一混合（理论上不会），两段都列出
      const cloudN = ready.filter(r => r.source === 'cloud').length
      const localN = ready.length - cloudN
      const parts = []
      if (cloudN) parts.push('成功识别记账：' + cloudN + ' 笔')
      if (localN) parts.push('已记账：' + localN + ' 笔（本地模板）')
      let title = parts.join('；')
      if (pending.length) title += '，' + pending.length + ' 笔缺少金额未记'
      // 文案超过 success 图标允许的 7 个字，统一用无图标 toast（可显示两行），保证各种情况下样式一致
      wx.showToast({ title, icon: 'none' })
      if (!keep) this.closeAI()
    }
  }
})
