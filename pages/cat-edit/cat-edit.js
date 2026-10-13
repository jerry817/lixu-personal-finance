// pages/cat-edit/cat-edit.js 编辑分类
//   ?type=expense|income          编辑该类型的一级分类
//   ?type=…&cat=<一级分类 id>      编辑该一级分类下的子分类
// 点图标修改（一级分类可改名 / 换图标，子分类可改名），× 删除，「新增」添加，长按拖动排序（松手保存）。
// 页面禁用滚动（见 json），拖动时手指所在格即落点，其余图标顺位移动。
//
// 状态约定（避免互相打架）：同一时刻只允许一种操作——
//   · 拖动中（this._drag）：不响应点击 / 删除 / 打开弹窗；
//   · 弹窗打开（data.sheet）：不能开始拖动，其余图标的点击 / 删除也被遮罩挡住；
//   · 删除确认中（this._confirming）：忽略其他操作，确认回来时按最新的列表删，不用点击时的旧快照。
// 名称输入不进 data（this._name），避免每敲一个字就 setData 重绘并把光标顶回去；图标选择 / 保存都读同一份状态。
const store = require('../../utils/store')
const cats = require('../../utils/categories')

const COLS = 5
const TILE_H = 150 // rpx，与 wxss 里 .ce-tile 的高度一致（按行高换算手指所在行）

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

Page({
  data: {
    isSub: false,
    items: [],      // 一级：{ id, label, icon, img }；子分类：{ id: 名称, label: 名称 }
    icons: [],      // 一级分类可选图标
    dragId: '',
    dragTf: '',
    sheet: false,
    sheetTitle: '',
    editId: '',     // 正在修改的项 id；空 = 新增
    name: '',       // 只在打开弹窗时灌入输入框；之后的输入存在 this._name
    icon: ''
  },

  onLoad(options) {
    this.type = options.type
    this.catId = options.cat || ''
    const cat = this.catId && store.getCat(this.catId, this.type)
    wx.setNavigationBarTitle({
      title: cat ? '编辑“' + cat.label + '”子分类' : '编辑' + (this.type === 'income' ? '收入' : '支出') + '分类'
    })
    this.setData({
      isSub: !!this.catId,
      icons: cats.getCats(this.type).map(c => ({ key: c.icon, path: cats.iconPath(c.icon, false) }))
    })
    this.load()
  },

  // 拖动要按网格位置算落点，页面渲染完成后量一次（页面不滚动，位置不会再变）
  onReady() {
    const px = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).windowWidth / 750
    wx.createSelectorQuery().select('.ce-grid').boundingClientRect(rect => {
      this._grid = rect
      this._cellW = rect.width / COLS
      this._cellH = TILE_H * px
    }).exec()
  },

  load() {
    const items = this.data.isSub
      ? store.subsOf(this.type, this.catId).map(n => ({ id: n, label: n }))
      : store.visibleCats(this.type).map(c => ({ id: c.id, label: c.label, icon: c.icon, img: cats.iconPath(c.icon, false) }))
    this.setData({ items })
  },

  // 当前能否开始一个新操作：没在拖动、没在等删除确认、没开着弹窗
  idle() {
    return !this._drag && !this._confirming && !this.data.sheet
  },

  // ------------------------------------------------ 新增 / 修改
  openSheet(e) {
    if (!this.idle()) return
    const id = e.currentTarget.dataset.id
    const item = this.data.items.find(x => x.id === id)
    this._name = item ? item.label : ''
    this.setData({
      sheet: true,
      editId: id || '',
      sheetTitle: (item ? '修改' : '新增') + (this.data.isSub ? '子分类' : '分类'),
      name: item ? item.label : '',
      icon: item ? item.icon : cats.getCat('other', this.type).icon
    })
  },

  closeSheet() { this.setData({ sheet: false }) },
  onName(e) { this._name = e.detail.value },
  pickIcon(e) {
    const icon = e.currentTarget.dataset.icon
    if (icon !== this.data.icon) this.setData({ icon })
  },

  confirmSheet() {
    if (!this.data.sheet) return // 已经保存过（连点「完成」）：忽略，避免重复新增
    const { isSub, items, editId, icon } = this.data
    const label = (this._name || '').trim()
    if (!label) { wx.showToast({ title: '请输入名称', icon: 'none' }); return }
    if (items.some(x => x.label === label && x.id !== editId)) {
      wx.showToast({ title: '已有同名项', icon: 'none' })
      return
    }
    if (isSub) {
      const names = items.map(x => x.label)
      store.saveSubs(this.type, this.catId, editId ? names.map(n => (n === editId ? label : n)) : names.concat(label))
    } else if (editId) {
      store.updateCat(this.type, editId, { label, icon })
    } else {
      store.addCustomCat(this.type, label, icon)
    }
    this.setData({ sheet: false })
    this.load()
  },

  // ------------------------------------------------ 删除
  deleteItem(e) {
    if (!this.idle()) return
    const { isSub, items } = this.data
    const id = e.currentTarget.dataset.id
    if (!isSub && items.length <= 1) { wx.showToast({ title: '至少保留一个分类', icon: 'none' }); return }
    const item = items.find(x => x.id === id)
    this._confirming = true
    wx.showModal({
      title: '删除“' + item.label + '”？',
      content: '已记的账单不受影响',
      success: (res) => {
        if (!res.confirm) return
        if (isSub) store.saveSubs(this.type, this.catId, this.data.items.filter(x => x.id !== id).map(x => x.label))
        else store.removeCat(this.type, id)
        this.load()
      },
      complete: () => { this._confirming = false }
    })
  },

  // ------------------------------------------------ 长按拖动排序
  onDragStart(e) {
    if (!this.idle() || !this._grid) return // 弹窗开着 / 删除确认中 / 网格尺寸还没量好：不进入拖动
    this._drag = { index: Number(e.currentTarget.dataset.index), moved: false }
    this.setData({ dragId: e.currentTarget.dataset.id })
    this.onDragMove(e)
  },

  onDragMove(e) {
    const d = this._drag
    if (!d) return
    const g = this._grid
    const { clientX, clientY } = e.touches[0]
    const items = this.data.items
    const col = clamp(Math.floor((clientX - g.left) / this._cellW), 0, COLS - 1)
    const row = clamp(Math.floor((clientY - g.top) / this._cellH), 0, Math.floor((items.length - 1) / COLS))
    const to = Math.min(row * COLS + col, items.length - 1)
    const patch = {}
    if (to !== d.index) {
      const next = items.slice()
      next.splice(to, 0, next.splice(d.index, 1)[0])
      d.index = to
      d.moved = true
      patch.items = next
    }
    // 被拖图标跟手：相对它当前所在格中心的位移
    const dx = clientX - g.left - (d.index % COLS + 0.5) * this._cellW
    const dy = clientY - g.top - (Math.floor(d.index / COLS) + 0.5) * this._cellH
    patch.dragTf = 'transform:translate(' + dx + 'px,' + dy + 'px) scale(1.12);'
    this.setData(patch)
  },

  // 拖动中页面被切走（来电、切应用）：当作松手处理，已经调整的顺序照常保存
  onHide() { this.onDragEnd() },

  onDragEnd() {
    const d = this._drag
    if (!d) return
    this._drag = null
    this.setData({ dragId: '', dragTf: '' })
    if (!d.moved) return
    const items = this.data.items
    if (this.data.isSub) store.saveSubs(this.type, this.catId, items.map(x => x.label))
    else store.saveCatOrder(this.type, items.map(x => x.id))
  }
})
