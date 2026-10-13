// 双设备 + 内存云端 模拟：每台设备在独立 vm 上下文里加载真实的 utils/*.js（供 selftest_live_sync.js 使用）。
// 定时器按 50 倍加速（600ms 防抖 → 12ms，30s 轮询 → 600ms）
const vm = require('vm'), fs = require('fs'), path = require('path')
const ROOT = process.env.YIMU_ROOT || path.resolve(__dirname, '..')
const SCALE = 50 // 定时器加速倍数

// ---------------- 内存云端
function makeCloud() {
  const cols = { bills: {}, user_meta: {} }
  const watchers = []
  let clock = 1_800_000_000_000
  const stats = { reads: 0, writes: 0, failReads: false, failWrites: false, watchSupported: true }
  const now = () => (clock += 5) // 严格递增的服务器时间
  const stamp = d => (d.syncedAt ? new Date(d.syncedAt).getTime() : (d.updateTime || 0)) // 监听用的文档版本戳：账单看 syncedAt，设置文档看 updateTime
  const SD = { __sd: true }
  const match = (doc, where) => Object.keys(where).every(k => {
    const c = where[k]
    if (c && c.__cmd === 'gt') return doc[k] && new Date(doc[k]).getTime() > new Date(c.v).getTime()
    return doc[k] === c
  })
  function Query(name, where, ord, skip, lim) {
    return {
      where: w => Query(name, w, ord, skip, lim),
      orderBy: (f, d) => Query(name, where, { f, d }, skip, lim),
      skip: n => Query(name, where, ord, n, lim),
      limit: n => Query(name, where, ord, skip, n),
      get() {
        stats.reads++
        if (stats.failReads) return Promise.reject(new Error('net-down'))
        let r = Object.values(cols[name]).filter(d => match(d, where))
        if (ord) r.sort((a, b) => (new Date(a[ord.f] || 0) - new Date(b[ord.f] || 0)) * (ord.d === 'desc' ? -1 : 1))
        r = r.slice(skip || 0, (skip || 0) + (lim || 20))
        const out = { data: r.map(x => JSON.parse(JSON.stringify(x), (k, v) => (k === 'syncedAt' && v ? new Date(v) : v))) }
        return stats.latency ? new Promise(res => setTimeout(() => res(out), stats.latency)) : Promise.resolve(out)
      },
      watch(h) {
        if (!stats.watchSupported) throw new Error('watch unsupported')
        const w = { h, where, ord, lim, last: null, closed: false }
        const top = () => { let r = Object.values(cols[name]).filter(d => match(d, where)); if (ord) r.sort((a, b) => (new Date(a[ord.f] || 0) - new Date(b[ord.f] || 0)) * (ord.d === 'desc' ? -1 : 1)); return r.slice(0, lim || 100) }
        w.top = top; w.name = name
        w.last = top().map(d => d._id + '@' + stamp(d))
        setTimeout(() => h.onChange({ type: 'init', docChanges: [] }), 0)
        watchers.push(w)
        return { close() { w.closed = true; return Promise.resolve() } }
      }
    }
  }
  function fire(name) {
    watchers.filter(w => !w.closed && w.name === name).forEach(w => {
      const t = w.top(); const sig = t.map(d => d._id + '@' + stamp(d))
      if (sig.join() === w.last.join()) return
      const changes = t.filter(d => !w.last.includes(d._id + '@' + stamp(d))).map(d => ({ dataType: 'update', doc: JSON.parse(JSON.stringify(d)) }))
      w.last = sig
      setTimeout(() => !w.closed && w.h.onChange({ type: 'update', docChanges: changes }), 1)
    })
  }
  const database = (openid) => ({
    serverDate: () => SD,
    command: { gt: v => ({ __cmd: 'gt', v }) },
    collection(name) {
      const q = Query(name, {}, null, 0, 20)
      return Object.assign(q, {
        doc: id => ({
          set({ data }) {
            if (stats.failWrites) return Promise.reject(new Error('net-down'))
            stats.writes++
            const d = JSON.parse(JSON.stringify(data)); d._id = id; d._openid = openid
            if (data.syncedAt === SD) d.syncedAt = new Date(now())
            cols[name][id] = d; fire(name); return Promise.resolve({})
          },
          get() { stats.reads++; const d = cols[name][id]; return d ? Promise.resolve({ data: d }) : Promise.reject(new Error('not exist')) }
        })
      })
    }
  })
  return { cols, stats, database, watchers, advance(ms) { clock += ms }, // 推进服务器时间（用来拉开两次写入的间隔，超出增量拉取的回退余量）
     breakWatchers(err) { watchers.filter(w => !w.closed).forEach(w => { w.closed = true; w.h.onError(err || new Error('ws closed')) }) } }
}

// ---------------- 设备
function makeDevice(cloudSrv, openid, name) {
  const storage = {}
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
  const log = []
  const wx = {
    cloud: { init() {}, database: () => cloudSrv.database(openid), callFunction: () => Promise.resolve({ result: { openid } }), deleteFile: () => Promise.resolve(), uploadFile: () => Promise.reject(new Error('no file')) },
    getStorageSync: k => (k in storage ? clone(storage[k]) : ''),
    setStorageSync: (k, v) => { storage[k] = clone(v) },
    removeStorageSync: k => { delete storage[k] },
    getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
    showToast: o => log.push('toast:' + o.title), showLoading() {}, hideLoading() {},
    login: o => o.success({ code: 'c' }),
    getAccountInfoSync: () => ({}),
  }
  storage.session = { openid, loginTime: 1 }
  storage.privacy_consent = { version: '2026-10-10', time: 1 }
  const pages = []
  const sandbox = { wx, console: { log() {}, info() {}, warn: (...a) => log.push('warn:' + a.join(' ')), error: console.error }, setTimeout: (f, ms) => setTimeout(f, (ms || 0) / SCALE), clearTimeout, Promise, Date, Math, JSON, Object, Array, Number, String, RegExp, Error, getApp: () => ({ globalData: {} }), getCurrentPages: () => pages, module: null }
  const ctx = vm.createContext(sandbox)
  const cache = {}
  function req(from, rel) {
    const file = require.resolve(path.resolve(path.dirname(from), rel))
    if (cache[file]) return cache[file].exports
    const mod = { exports: {} }; cache[file] = mod
    const code = fs.readFileSync(file, 'utf8')
    vm.runInContext('(function(module,exports,require){' + code + '\n})', ctx, { filename: file })(mod, mod.exports, r => req(file, r))
    return mod.exports
  }
  // privacy.hasAgreed 依赖存储键：读一下真实实现
  const mods = { store: req(ROOT + '/x.js', './utils/store.js'), cloud: req(ROOT + '/x.js', './utils/cloud.js'), privacy: req(ROOT + '/x.js', './utils/privacy.js') }
  return { name, wx, storage, log, pages, ...mods }
}
module.exports = { makeCloud, makeDevice }
