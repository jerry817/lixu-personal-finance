// components/ai-sheet AI 智能记账弹窗
//
// 一句话输入 + 日期 / 标签 / 账户 / 报销 四个可手动指定的属性。
// 识别与覆盖：ai.recognizeAll 识别 → ai.applyOverrides 用「用户动过」的 chip 覆盖 → 事件交给页面入账。
//
// 动效与键盘：
//   · 输入框在子组件里，父级随键盘 setData 不会再次聚焦，避免键盘弹两次；
//   · wx.onKeyboardHeightChange + textarea keyboardheightchange，duration 兼容秒/毫秒；
//   · 卡片 transform 时长跟键盘动画走，曲线接近系统键盘；有上次高度时与键盘同时起跳。
// 选项不收键盘：
//   · textarea 与新建标签 input 都带 hold-keyboard，点其它区域不收起键盘；
//   · 日期 / 标签 / 账户都做成卡片上方的浮层（不用系统 picker——它一弹出就会收键盘）。
// 日期是例外：做成贴屏幕底的整宽底部面板（设计图 2），打开时底部内容全部收起——
//   输入卡片 + 标题整体下滑淡出（.stack-hide）、软键盘收起（focus:false）、原生 tabBar 隐藏（setTabBar）；
//   选好后点「完成」（或「取消」/ 点面板外）面板落下，输入卡片、tabBar、键盘一起恢复。
//   日历里点的日期、时间只是暂存（calSel / selTime），点「完成」才写进 date / time。
const store = require('../../utils/store')
const util = require('../../utils/util')
const ai = require('../../utils/ai')
const kinds = require('../../utils/accountKinds')

const KB_KEY = 'ai_kb_h'     // 上次键盘高度（px）
const EXIT_MS = 220          // 退场动画时长
const KB_DEFAULT_MS = 250    // iOS 键盘动画默认时长
const CARD_H = 146           // 输入卡片高度（px，估算，用来算浮层可用高度）
const POP_GAP = 14           // 浮层与卡片的间距（px）
const HEAD_H = 48            // 浮层标题栏高度（px）

// keyboardheightchange 的 duration 常为毫秒；wx.onKeyboardHeightChange 为秒。>10 视为已是毫秒。
function kbDurMs(d) {
  d = Number(d)
  if (!(d > 0)) return 0
  return d <= 10 ? Math.round(d * 1000) : Math.round(d)
}

function sys() {
  let w = {}
  try { w = wx.getWindowInfo() } catch (e) { w = {} }
  if (!w.windowHeight) { try { w = wx.getSystemInfoSync() } catch (e) { w = {} } }
  const screenH = w.screenHeight || w.windowHeight || 800
  const sa = w.safeArea
  const winH = w.windowHeight || screenH
  const windowTop = w.windowTop || 0
  return {
    winH,
    safeB: sa ? Math.max(0, screenH - sa.bottom) : 0,   // 底部安全区（Home 条）
    safeT: sa ? sa.top : (w.statusBarHeight || 20),      // 顶部安全区 / 状态栏
    // 窗口底到屏幕底：tab 页上就是原生 tabBar。键盘高度从屏幕底起算，上抬要扣掉这段，才不会把卡片顶过键盘
    below: Math.max(0, screenH - windowTop - winH)
  }
}

Component({
  properties: {
    visible: { type: Boolean, value: false }
  },

  data: {
    rendered: false,    // 是否挂载（退场动画期间 visible 已为 false 但仍要渲染）
    closing: false,
    lift: 0,            // 卡片上抬量（px）= 键盘高度 - 底部安全区
    dur: KB_DEFAULT_MS, // 上抬过渡时长（ms，随键盘）

    text: '',
    focus: false,
    loading: false,
    ledger: '日常账本',

    pop: '',            // '' | 'acc' | 'tag' | 'date' | 'reimb'：'date' 是底部面板（卡片收起），其余是卡片上方的浮层
    popMax: 240,        // 浮层列表区最大高度（px）

    date: '',
    dateDay: 0,
    dateTouched: false,
    calSel: '',         // 日历浮层里暂选的日期（点「完成」才生效）
    weekHead: ['一', '二', '三', '四', '五', '六', '日'],
    calYm: '',          // 月历当前月份 YYYY-MM（标题 + 月份选择器的值）
    calCells: [],

    tag: '',
    tagTouched: false,
    tags: [],
    newTag: '',

    accId: '',
    accName: '无账户',
    accIcon: '',
    accTouched: false,
    accSelGroup: '',    // 当前所选账户所属分组（二级菜单里给分组打勾点）
    accMode: 'flat',    // flat=平铺（图示）；group=二级菜单（先分组、再账户）
    accGroup: '',       // 二级菜单：当前展开的分组 key（'' = 一级）
    accGroupLabel: '',
    accGroups: [],
    accList: [],

    reimburse: false,
    reimTouched: false,
    reimbList: [],
    reimburseAccountId: '',
    reimburseAccountName: '',
    reimburseAccountIcon: '',

    time: '',
    timeTouched: false,
    selTime: ''
  },

  lifetimes: {
    attached() {
      this._kbCb = res => this.applyKb(res && res.height, res && res.duration)
      this._tabHidden = false
    },
    detached() {
      this.setTabBar(false) // 日历开着时页面被销毁：别把 tabBar 留在隐藏状态
      this.unlistenKb()
      clearTimeout(this._exitTimer)
      clearTimeout(this._kbTimer)
    }
  },

  observers: {
    visible(v) {
      if (v) this.open()
      else this.shutdown()
    },
    // 日历面板开 / 关：原生 tabBar 同步收起 / 放回（面板贴屏幕底，tabBar 盖不住，只能让它让位）
    pop(p) { this.setTabBar(p === 'date') }
  },

  methods: {
    // ------------------------------------------------------------ 打开 / 关闭
    open() {
      clearTimeout(this._exitTimer)
      clearTimeout(this._kbTimer)
      this._openTs = Date.now()
      this._kbReal = undefined
      // 窗口底到屏幕底（原生 tabBar）：此刻 tabBar 还在。日历收起 tabBar 会改变窗口高度，所以在这里量好、整个弹窗期间沿用
      this._below = sys().below

      const today = util.dateStr()
      const clock = this.nowClock()
      const p = today.split('-')

      // 支出账户选择器排除二手货物(goods)和债务(debt)，保留资金/信贷/充值/投资账户
      const accounts = store.getAccounts(false)
        .filter(a => {
          const g = kinds.groupOf(a)
          return g !== 'goods' && g !== 'debt'
        })
        .map(a => ({
          id: a.id, name: a.name, icon: a.icon, group: kinds.groupOf(a)
        }))
      this._accounts = accounts
      // 默认账户：上次手动选择的收支账户（没有则无账户）。没动 chip 时，一句话里没说账户的账单就记到它
      const lastAcc = accounts.find(a => a.id === store.lastAccountId(accounts))
      // 报销账户 = 债务分组下 kind=reimburse 的账户
      const reimbList = store.getAccounts(false)
        .filter(a => kinds.groupOf(a) === 'debt' && a.kind === 'reimburse')
        .map(a => ({ id: a.id, name: a.name, icon: a.icon }))
      this._cal = null

      const pred = this._kbLast || Number(wx.getStorageSync(KB_KEY)) || 0
      if (pred > 0) this._kbLast = pred

      // 先听键盘再挂载并聚焦：只 setData 一次（含 focus），避免二次聚焦把键盘再弹一遍
      this.listenKb()
      this.setData({
        rendered: true, closing: false, loading: false,
        text: '', newTag: '', pop: '',
        tags: store.tagStats().slice(0, 20).map(t => t.tag),
        tag: '', tagTouched: false,
        accId: lastAcc ? lastAcc.id : '', accName: lastAcc ? lastAcc.name : '无账户',
        accIcon: lastAcc ? lastAcc.icon : '', accSelGroup: lastAcc ? lastAcc.group : '',
        accTouched: false, accGroup: '', accGroupLabel: '',
        reimburse: false, reimTouched: false,
        reimbList, reimburseAccountId: '', reimburseAccountName: '', reimburseAccountIcon: '',
        date: today,
        dateDay: Number(p[2]),
        dateTouched: false,
        time: clock, timeTouched: false, selTime: clock,
        lift: 0, dur: KB_DEFAULT_MS,
        popMax: this.popMaxFor('acc', 0),
        focus: true
      }, () => {
        // 从 0 起跳到上次高度，和系统键盘同一档时长一起上升
        if (pred > 0) {
          wx.nextTick(() => this.applyKb(pred, KB_DEFAULT_MS / 1000, 'pred'))
          this._kbTimer = setTimeout(() => {
            if (this._kbReal === undefined) this.applyKb(0)
          }, 900)
        }
      })
    },

    shutdown() {
      if (!this.data.rendered) return
      clearTimeout(this._kbTimer)
      // 收键盘 + 退场动画；键盘下去的事件会带着卡片同步下落
      this.setData({ closing: true, focus: false, pop: '' })
      this._exitTimer = setTimeout(() => {
        this.unlistenKb()
        this.setData({ rendered: false, closing: false, lift: 0 })
        this.triggerEvent('closed')
      }, EXIT_MS)
    },

    close() {
      this.triggerEvent('close')
    },

    onMaskTap() {
      if (this.data.pop) this.closePop()
      else this.close()
    },

    noop() {},

    // 日历面板展开时收起原生 tabBar、关闭时放回；_tabHidden 防重复调用。
    // 关弹窗 / 离开页面时 pop 回 '' 也会走到这里，tabBar 一并恢复
    setTabBar(hide) {
      if (this._tabHidden === hide) return
      this._tabHidden = hide
      if (hide) wx.hideTabBar({ animation: true })
      else wx.showTabBar({ animation: true })
    },

    // ------------------------------------------------------------ 键盘同步
    listenKb() {
      if (this._listening) return
      this._listening = true
      if (typeof wx.onKeyboardHeightChange === 'function') wx.onKeyboardHeightChange(this._kbCb)
    },

    unlistenKb() {
      if (!this._listening) return
      this._listening = false
      if (typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(this._kbCb)
    },

    // textarea.keyboardheightchange（duration 多为毫秒）与 wx.onKeyboardHeightChange（多为秒）
    onKb(e) {
      this.applyKb(e.detail.height, e.detail.duration)
    },

    // 键盘高度变化（h=0 为收起）。预测 / 双监听重复触发无副作用
    applyKb(h, durRaw, src) {
      if (!this.data.rendered) return
      h = Number(h) || 0
      // 打开瞬间偶发 height=0，吞掉以免卡片掉下去再抬起
      if (h === 0 && src !== 'pred' && !this.data.closing && this.data.focus && Date.now() - this._openTs < 480) return
      if (src === 'pred' && this._kbReal !== undefined) return

      let dur = kbDurMs(durRaw)
      const lift = h > 0 ? Math.max(0, h - this._below) : 0
      const delta = Math.abs(lift - this.data.lift)
      // 无 duration：大位移（键盘刚开始弹）用默认时长跟上；已在终点附近则贴着走，避免键盘停了卡片还在滑
      if (dur <= 0) dur = (src === 'pred' || (this.data.lift === 0 && lift > 80)) ? KB_DEFAULT_MS : (delta > 24 ? KB_DEFAULT_MS : 0)

      if (src !== 'pred') {
        this._kbReal = h
        clearTimeout(this._kbTimer)
        if (h > 0 && h !== this._kbSaved) {
          this._kbLast = h
          this._kbSaved = h
          try { wx.setStorageSync(KB_KEY, h) } catch (e) { /* ignore */ }
        }
      }

      const up = {}
      if (lift !== this.data.lift) up.lift = lift
      if (dur !== this.data.dur) up.dur = dur
      if (this.data.pop) up.popMax = this.popMaxFor(this.data.pop, lift)
      if (Object.keys(up).length) this.setData(up)
    },

    // 浮层列表区最大高度：屏高 - 键盘占用 - 卡片 - 间距 - 顶部安全区 - 标题栏
    popMaxFor(pop, lift) {
      const s = sys()
      const extra = pop === 'tag' ? 46 : 0 // 标签：新建输入行
      const room = s.winH - lift - 10 - CARD_H - POP_GAP - (s.safeT + 10) - HEAD_H - extra
      return Math.max(130, Math.floor(room))
    },

    onText(e) { this.setData({ text: e.detail.value }) },
    // 只在标志位不一致时写 focus，避免无意义 setData
    onFocus() { if (!this.data.focus) this.setData({ focus: true }) },
    onBlur() { if (this.data.focus && !this.data.closing) this.setData({ focus: false }) },

    // 焦点在别的输入框（新建标签）被拿走后，把焦点还给文本框，键盘保持
    refocus() {
      this.setData({ focus: false }, () => {
        setTimeout(() => this.setData({ focus: true }), 40)
      })
    },

    // ------------------------------------------------------------ 浮层通用
    openPop(e) {
      const p = e.currentTarget.dataset.p
      if (this.data.pop === p) { this.closePop(); return }
      const up = { pop: p, popMax: this.popMaxFor(p, this.data.lift) }
      if (p === 'acc') Object.assign(up, this.accView(this.data.accMode, ''))
      // 日历：键盘收起，卡片收起（pop='date' 触发 .stack-hide），暂存值从当前日期时间起
      if (p === 'date') {
        Object.assign(up, this.calView(this.data.date), {
          calSel: this.data.date, selTime: this.data.time || this.nowClock(), focus: false
        })
      }
      this.setData(up)
    },

    closePop() {
      if (!this.data.pop) return
      if (this.data.pop === 'date') { this.finishDate(false); return } // 点浮层外 = 取消
      this.setData({ pop: '' })
      if (this._tagFocused) this.refocus() // 新建标签输入框被卸载会带走键盘，还给文本框
    },

    // ------------------------------------------------------------ 账户（一级 / 二级菜单）
    // mode=flat：无账户 + 全部账户（图示）；mode=group：先选分组，再选该分组下的账户
    accView(mode, groupKey) {
      const all = this._accounts || []
      const groups = kinds.GROUPS.map(g => ({
        key: g.key, label: g.label, icon: g.kinds[0].icon,
        accounts: all.filter(a => a.group === g.key)
      })).filter(g => g.accounts.length).map(g => Object.assign(g, { count: g.accounts.length }))
      const grp = groups.find(g => g.key === groupKey)
      return {
        accMode: mode,
        accGroups: groups.map(g => ({ key: g.key, label: g.label, icon: g.icon, count: g.count })),
        accGroup: grp ? grp.key : '',
        accGroupLabel: grp ? grp.label : '',
        accList: mode === 'flat' ? all : (grp ? grp.accounts : [])
      }
    },

    // 标题栏右上角图标：平铺 ⇄ 二级菜单
    toggleAccMode() {
      this.setData(this.accView(this.data.accMode === 'flat' ? 'group' : 'flat', ''))
    },

    // 二级菜单：进入分组
    openGroup(e) {
      this.setData(this.accView('group', e.currentTarget.dataset.g))
    },

    accBack() {
      this.setData(this.accView('group', ''))
    },

    pickAcc(e) {
      const id = e.currentTarget.dataset.id
      const a = (this._accounts || []).find(x => x.id === id)
      this.setData({
        accId: id, accName: a ? a.name : '无账户', accIcon: a ? a.icon : '',
        accSelGroup: a ? a.group : '', accTouched: true, pop: ''
      })
    },

    // ------------------------------------------------------------ 标签
    pickTag(e) {
      const t = e.currentTarget.dataset.t
      // 再点一次已选标签 = 取消
      this.setData({ tag: this.data.tag === t ? '' : t, tagTouched: true, pop: '' })
    },

    onNewTag(e) { this.setData({ newTag: e.detail.value }) },
    onTagFocus() { this._tagFocused = true },
    onTagBlur() { this._tagFocused = false },

    addTag() {
      const t = this.data.newTag.trim()
      if (!t) return
      this.setData({ tag: t, tagTouched: true, newTag: '', pop: '' })
      this.refocus()
    },

    // ------------------------------------------------------------ 日期（浮层月历，不用系统 picker）
    // 当前时间 HH:mm
    nowClock() {
      const n = new Date()
      return util.pad(n.getHours()) + ':' + util.pad(n.getMinutes())
    },

    // date=YYYY-MM-DD，time=HH:mm；日期 chip 只显示日历图标（日号），具体日期时间在日历浮层里看
    setDate(date, time, touched) {
      const p = date.split('-')
      const t = (time !== undefined && time !== null && time !== '') ? time : (this.data.time || this.nowClock())
      this.setData({
        date,
        time: t,
        dateDay: Number(p[2]),
        dateTouched: touched,
        timeTouched: touched
      })
    },

    // 月历数据（周一为一周起点；只画本月所需行数）
    calView(selDate, y, m) {
      if (!y) { const p = selDate.split('-'); y = Number(p[0]); m = Number(p[1]) }
      this._cal = { y, m }
      const dim = util.daysInMonth(y, m)
      const startWd = (new Date(y, m - 1, 1).getDay() + 6) % 7
      const rows = Math.ceil((startWd + dim) / 7)
      const today = util.dateStr()
      const ym = util.monthKey(y, m)
      const cells = []
      for (let i = 0; i < rows * 7; i++) {
        const n = i - startWd + 1
        if (n < 1 || n > dim) { cells.push({ id: i, empty: true }); continue }
        const date = ym + '-' + util.pad(n)
        cells.push({ id: i, day: n, date, wk: i % 7 > 4, sel: date === selDate, today: date === today })
      }
      return { calYm: ym, calCells: cells }
    },

    // 标题上的月份选择器（YYYY-MM）：跳到该月，暂选日期不变
    onPickMonth(e) {
      const p = e.detail.value.split('-')
      this.setData(this.calView(this.data.calSel || this.data.date, Number(p[0]), Number(p[1])))
    },

    // 点日期 = 暂选（停留在当前月份），点「完成」才生效
    pickDate(e) {
      const date = e.currentTarget.dataset.date
      if (!date) return
      const c = this._cal || {}
      this.setData(Object.assign({ calSel: date }, this.calView(date, c.y, c.m)))
    },

    // 回今天：同样只是暂选，月历跳回今天所在的月份
    backToday() {
      const today = util.dateStr()
      this.setData(Object.assign({ calSel: today }, this.calView(today)))
    },

    cancelDate() { this.finishDate(false) },
    confirmDate() { this.finishDate(true) },

    // 关闭日历面板（卡片随之展开）并把键盘弹回来。commit=true：暂选的日期 / 时间写进 date / time（有变化才算「动过」，
    // 动过的才会覆盖一句话里识别出的日期）；false：丢弃暂选
    finishDate(commit) {
      const d = this.data
      if (commit && d.calSel) {
        const changed = d.calSel !== d.date || d.selTime !== d.time
        this.setDate(d.calSel, d.selTime, changed || d.dateTouched)
      }
      this.setData({ pop: '', focus: true })
    },

    // 报销账户选择：id 空 = 不报销
    pickReimb(e) {
      const id = e.currentTarget.dataset.id
      if (!id) {
        this.setData({
          reimburse: false, reimTouched: true,
          reimburseAccountId: '', reimburseAccountName: '', reimburseAccountIcon: '', pop: ''
        })
        return
      }
      const a = (this.data.reimbList || []).find(x => x.id === id)
      this.setData({
        reimburse: true, reimTouched: true,
        reimburseAccountId: id, reimburseAccountName: a ? a.name : '', reimburseAccountIcon: a ? a.icon : '',
        pop: ''
      })
    },

    // 时间行：原生 time picker 选择 HH:mm 后更新（随选日期一起提交）
    onPickTime(e) {
      const v = e.detail.value
      if (v) this.setData({ selTime: v })
    },

    // ------------------------------------------------------------ 提交：点 ✓ 记账并关闭；长按 ✓ 记账后保留弹窗继续记下一笔
    submit() { this.doSubmit(false) },
    submitKeep() { this.doSubmit(true) },

    doSubmit(keep) {
      const text = this.data.text.trim()
      if (!text || this.data.loading) return
      const d = this.data
      const ov = {}
      if (d.dateTouched) ov.date = d.date
      if (d.timeTouched) ov.time = d.time
      if (d.tagTouched) ov.tag = d.tag
      // 动过账户 chip → 覆盖识别结果；没动 → chip 上显示的默认账户只补给没说账户的账单
      if (d.accTouched) ov.accountId = d.accId
      else ov.defaultAccountId = d.accId
      if (d.reimTouched) {
        ov.reimburse = d.reimburse
        ov.reimburseAccountId = d.reimburseAccountId
        ov.reimburseAccount = d.reimburseAccountName
      }
      // 识别期间键盘保持不动（不改 focus）
      this.setData({ loading: true, pop: '' })
      ai.recognizeAll(text).then(list => {
        this.setData({ loading: false })
        // 手动选了账户：记住它，下次（含记账页）默认用它
        if (d.accTouched && d.accId) store.setLastAccountId(d.accId)
        this.triggerEvent('result', { list: ai.applyOverrides(list, ov), keep })
        if (keep) this.setData({ text: '' })
      }).catch(() => {
        this.setData({ loading: false })
        wx.showToast({ title: '识别失败，请重试', icon: 'none' })
      })
    }
  }
})
