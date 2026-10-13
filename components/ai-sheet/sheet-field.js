// 输入框单独做成子组件：父级随键盘 setData 上抬时不会重绘 textarea，
// 避免 focus 一直为 true 时被再次聚焦、键盘弹第二次。
Component({
  options: { virtualHost: true },
  properties: {
    value: { type: String, value: '' },
    focus: { type: Boolean, value: false }
  },
  methods: {
    onText(e) { this.triggerEvent('input', e.detail) },
    onFocus(e) { this.triggerEvent('focus', e.detail) },
    onBlur(e) { this.triggerEvent('blur', e.detail) },
    onKb(e) { this.triggerEvent('kb', e.detail) }
  }
})
