// utils/linechart.js DOM 折线图工具（统计页「资产走势 / 收支走势」与预算页「预算趋势」共用）
//
// 不用 canvas（原生组件，页面滚动 / 折叠动画时不跟手），而是普通 view + CSS：
// 一条线 = 面积图层（线性渐变 + clip-path 裁形状）+ 折线图层，各占一个 view，点再多也不会撑出几百个节点。
// 坐标在 rpx 空间里算好，再换算成百分比交给 clip-path，所以 TA 的 w / h 必须与对应绘图区的 CSS 尺寸一致。
//
// create(TA) → { taClip, taFill, taDir, taMiter, taArc, taStroke, taSeries }
//   TA = { w, h, lw, miter }：绘图区宽高（rpx）、线宽（rpx）、尖角截断比
//   taSeries(pts, 'r,g,b', alphaTop, alphaBottom, k) → { area: {k, cls, style}, line: {k+1, cls, style} }
function create(TA) {
  // rpx 坐标 -> clip-path 多边形
  function taClip(pts) {
    return 'clip-path:polygon(' + pts
      .map(p => (p[0] / TA.w * 100).toFixed(2) + '% ' + (p[1] / TA.h * 100).toFixed(2) + '%')
      .join(',') + ')'
  }

  // 面积多边形：折线两端垂落到绘图区底部封口
  function taFill(pts) {
    return pts.concat([[pts[pts.length - 1][0], TA.h], [pts[0][0], TA.h]])
  }

  // 单位方向
  function taDir(a, b) {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    return [dx / len, dy / len]
  }

  // 两条偏移线（法线分别为 m1 / m2）的交点：沿角平分线偏移 h/cos(θ/2)；
  // 太尖的角按 TA.miter 截断，避免长出细长的尖刺。
  function taMiter(p, m1, m2, h) {
    let mx = m1[0] + m2[0]
    let my = m1[1] + m2[1]
    const len = Math.sqrt(mx * mx + my * my)
    if (len) { mx /= len; my /= len } else { mx = m1[0]; my = m1[1] }
    const f = h / Math.max(mx * m1[0] + my * m1[1], 1 / TA.miter)
    return [p[0] + mx * f, p[1] + my * f]
  }

  // 以 p 为圆心、h 为半径，从方向 a 到方向 b 的短弧（含两端点；每段 ≤ 60°、最多 3 段。
  // h 只有 2rpx，3 段的多边形与真圆弧差 0.27rpx，肉眼不可见，点数却省一半以上）
  function taArc(p, a, b, h) {
    const s = Math.atan2(a[1], a[0])
    let e = Math.atan2(b[1], b[0]) - s
    while (e > Math.PI) e -= 2 * Math.PI
    while (e < -Math.PI) e += 2 * Math.PI
    const steps = Math.min(3, Math.max(1, Math.round(Math.abs(e) / (Math.PI / 3))))
    const out = [[p[0] + a[0] * h, p[1] + a[1] * h]]
    for (let k = 1; k <= steps; k++) {
      if (k === steps) {
        out.push([p[0] + b[0] * h, p[1] + b[1] * h])
      } else {
        const ang = s + e * k / steps
        out.push([p[0] + Math.cos(ang) * h, p[1] + Math.sin(ang) * h])
      }
    }
    return out
  }

  // 折线 -> 描边多边形（整条线只占一个 view）：
  // 直段沿法线平移半个线宽；转角在“外侧”用半径 h 的圆弧倒圆（等价 canvas 的 lineJoin: round，尖峰顶点就圆润了），
  // 内侧取两条偏移线的交点（h 只有 2rpx，内侧这点差别看不出来）；两端落在绘图区边界上，不做端帽。
  function taStroke(pts) {
    const h = TA.lw / 2
    const top = []
    const bot = []
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      const d1 = i > 0 ? taDir(pts[i - 1], p) : null
      const d2 = i < n - 1 ? taDir(p, pts[i + 1]) : null
      // 上侧法线：首末点只有一侧有线段，两侧取同一条，退化成普通平移
      const u1 = d1 ? [d1[1], -d1[0]] : null
      const u2 = d2 ? [d2[1], -d2[0]] : null
      const a1 = u1 || u2
      const a2 = u2 || u1
      const cross = d1 && d2 ? d1[0] * d2[1] - d1[1] * d2[0] : 0
      if (cross > 0) {
        // 上侧在转角外侧：上侧倒圆，下侧取交点
        top.push.apply(top, taArc(p, a1, a2, h))
        bot.push(taMiter(p, [-a1[0], -a1[1]], [-a2[0], -a2[1]], h))
      } else if (cross < 0) {
        // 下侧在转角外侧
        top.push(taMiter(p, a1, a2, h))
        bot.push.apply(bot, taArc(p, [-a1[0], -a1[1]], [-a2[0], -a2[1]], h))
      } else {
        // 直段
        top.push([p[0] + a1[0] * h, p[1] + a1[1] * h])
        bot.push([p[0] - a1[0] * h, p[1] - a1[1] * h])
      }
    }
    return top.concat(bot.reverse())
  }

  // 一条线 = 面积图层 + 折线图层，各带唯一 k（wx:key 用）
  function taSeries(pts, rgb, a0, a1, k) {
    return {
      area: {
        k,
        cls: 'ta-area',
        style: taClip(taFill(pts)) + ';background:linear-gradient(180deg,rgba(' + rgb + ',' + a0 + '),rgba(' + rgb + ',' + a1 + '))'
      },
      line: {
        k: k + 1,
        cls: 'ta-line',
        style: taClip(taStroke(pts)) + ';background:rgb(' + rgb + ')'
      }
    }
  }

  return { taClip, taFill, taDir, taMiter, taArc, taStroke, taSeries }
}

module.exports = { create }
