// utils/cloud.js
/**
 * 微信云开发：登录态 + 账单云同步
 *
 * 启用步骤：
 * 1. 在微信开发者工具中开通「云开发」，创建云环境；
 * 2. 将环境 ID 填入下方 CLOUD_ENV；
 * 3. 右键 cloudfunctions/login 目录 →「上传并部署：云端安装依赖」；
 * 4. 数据库新建集合 bills 与 user_meta，权限均设为「仅创建者可读写」；
 * 5. 云存储（附件图片/文件）：控制台「云存储 → 权限设置」选「仅创建者可读写」；
 *    附件上传到 attachments/{openid}/ 目录，账单文档里只保存 fileID；
 * 6. （AI）可选：新建云函数 ai-recognize，见 utils/ai.js。
 *
 * 数据归属：所有云端文档由数据库自动写入 _openid，「仅创建者可读写」保证
 * 用户只能读到自己的数据；本地保存的 openid 仅用于查询条件与界面展示。
 */
const privacy = require('./privacy')

const CLOUD_ENV = '' // TODO: 填入云环境 ID，例如 'cloud1-xxxxxx'

const K_SESSION = 'session'
const K_LAST_UPLOAD = 'last_upload_time' // 最近一次成功上传云端数据（账单/账户预算/附件）的时间戳
const PAGE = 20 // 小程序端单次查询上限为 20 条
const PULL_OVERLAP = 60 * 1000 // 增量拉取时游标回退的余量：服务器写入与提交之间可能有先后错位，宁可多拉几条重复的（合并是幂等的），也不漏

// 基础库支持云开发且配置了环境（与用户是否同意协议无关；只用来区分「开发者没配好」和「用户还没同意」）
function configured() {
  return !!(wx.cloud && CLOUD_ENV)
}

let inited = false

// 初始化云开发。只有用户同意了隐私协议才会初始化（traceUser 会在云端记录访问用户），未同意时什么都不做；
// 可重复调用。app.js 启动时调用一次，登录同意后（login）、以及任何云调用前（ready）都会再补一次
function initCloud() {
  if (inited) return
  if (!wx.cloud) {
    console.warn('[cloud] 当前基础库不支持云开发')
    return
  }
  if (!CLOUD_ENV) {
    console.info('[cloud] 未配置 CLOUD_ENV，云功能暂不可用（本地记账不受影响）')
    return
  }
  if (!privacy.hasAgreed()) return
  wx.cloud.init({ env: CLOUD_ENV, traceUser: true })
  inited = true
}

// 云能力是否可用：已配置环境 + 用户同意过隐私协议（顺带完成初始化）
function ready() {
  if (!configured() || !privacy.hasAgreed()) return false
  initCloud()
  return inited
}

function db() {
  return wx.cloud.database()
}

// ------------------------------------------------------------- 登录态
function getSession() {
  return wx.getStorageSync(K_SESSION) || null
}

function getOpenid() {
  const s = getSession()
  return s && s.openid ? s.openid : ''
}

function isLoggedIn() {
  return !!getOpenid()
}

function bindGlobal(openid) {
  if (typeof getApp === 'function') {
    const app = getApp()
    if (app && app.globalData) app.globalData.openid = openid
  }
}

function rawCall(name, data) {
  return wx.cloud.callFunction({ name, data }).then(r => r.result)
}

// 调用云函数，resolve 其返回值（wx.cloud 只在本文件里出现）。
// 所有云函数（AI 识别等）都要求已登录：未登录直接拒绝，不会发出任何云请求（login 云函数除外，走 rawCall）
function callFn(name, data) {
  if (!ready()) return Promise.reject(new Error('cloud-not-ready'))
  if (!isLoggedIn()) return Promise.reject(new Error('not-logged-in'))
  return rawCall(name, data)
}

// 登录：wx.login 取 code，经云函数换取 openid 并持久化。调用前必须已同意隐私协议
function login() {
  return new Promise((resolve, reject) => {
    if (!privacy.hasAgreed()) {
      reject(new Error('privacy-not-agreed'))
      return
    }
    if (!ready()) {
      reject(new Error('cloud-not-ready'))
      return
    }
    wx.login({
      success(res) {
        rawCall('login', { code: res.code })
          .then(r => {
            const openid = r && r.openid
            if (!openid) throw new Error('no-openid')
            wx.setStorageSync(K_SESSION, { openid, loginTime: Date.now() })
            bindGlobal(openid)
            resolve({ openid })
          })
          .catch(reject)
      },
      fail: reject
    })
  })
}

// 退出登录只清掉登录态：本机账单 / 账户 / 预算原样保留（离线 / 游客模式继续用，直到用户主动清空缓存）
function logout() {
  wx.removeStorageSync(K_SESSION)
  wx.removeStorageSync(K_LAST_UPLOAD)
  bindGlobal('')
}

// ------------------------------------------------------------- 最近上传时间
function markUploaded(ts) {
  wx.setStorageSync(K_LAST_UPLOAD, ts || Date.now())
}

function getLastUploadTime() {
  return Number(wx.getStorageSync(K_LAST_UPLOAD)) || 0
}

// 启动时把已保存的登录态挂到 globalData
function restoreSession() {
  bindGlobal(getOpenid())
}

// ------------------------------------------------------------- 账单读写
// 云端文档的 _id / _openid 由数据库维护，入本地前剔除
function clean(doc) {
  const o = Object.assign({}, doc)
  delete o._id
  delete o._openid
  delete o.syncedAt // 云端写入时间只用来做增量拉取的游标，不进本地账单
  return o
}

// 附件在云端文档里只保留 fileID 等可跨设备使用的字段；
// 本机路径（wxfile:// 或 http://tmp/）换台设备/清缓存后即失效，不能入库。
// 尚未上传成功（无 fileID）的附件不入库，留在本地等待下次同步重试。
function cloudAttachments(list) {
  return (Array.isArray(list) ? list : [])
    .filter(a => a && a.fileID)
    .map(a => ({ id: a.id, type: a.type, name: a.name, fileID: a.fileID }))
}

// 单条账单上云（用账单自身 id 作为文档 id，便于去重）
function syncBill(bill) {
  if (!ready() || !isLoggedIn()) return Promise.resolve(false)
  const data = Object.assign({}, bill)
  delete data._id
  delete data._openid
  data.attachments = cloudAttachments(bill.attachments)
  data.syncedAt = db().serverDate() // 服务器写入时间：其它设备据此只拉取比自己游标新的文档（含墓碑）
  return db().collection('bills').doc(bill.id).set({ data })
    .then(r => { markUploaded(); return r })
}

// 分页拉取：按条件读完全部（每页 20 条）。resolve { docs, cursor }：cursor 是这批文档里最大的云端写入时间（毫秒，没有则 0）
function fetchAll(where, orderField) {
  const docs = []
  let cursor = 0
  const step = (skip) => {
    return db().collection('bills').where(where).orderBy(orderField, 'asc').skip(skip).limit(PAGE).get().then(r => {
      r.data.forEach(d => {
        if (d.syncedAt) cursor = Math.max(cursor, new Date(d.syncedAt).getTime())
        docs.push(clean(d))
      })
      return r.data.length < PAGE ? { docs, cursor } : step(skip + PAGE)
    })
  }
  return step(0)
}

// 拉取当前用户的云端账单。since 为 null：全量（该设备第一次同步）；
// 为毫秒时间戳：只拉云端写入时间晚于 since（回退 PULL_OVERLAP 余量）的文档，没有变化时就是 1 次 0 条的查询
function loadCloudBills(since) {
  const openid = getOpenid()
  if (!ready() || !openid) return Promise.reject(new Error('cloud-not-ready'))
  if (since === null || since === undefined) return fetchAll({ _openid: openid }, 'createTime')
  const gt = db().command.gt(new Date(since - PULL_OVERLAP))
  return fetchAll({ _openid: openid, syncedAt: gt }, 'syncedAt')
}

// ------------------------------------------------------------- 账户 / 预算（每用户一份）
function syncMeta(meta) {
  const openid = getOpenid()
  if (!ready() || !openid) return Promise.resolve(false)
  return db().collection('user_meta').doc(openid).set({ data: meta })
    .then(r => { markUploaded(); return r })
}

// 读取云端账户 / 预算。用 where 查询而不是 doc().get()：文档不存在时前者返回空数组（= 云端确实没有），
// 而网络 / 权限等真正的失败会如实 reject。之前把所有错误都当成「云端没有」，弱网下读失败会被当成
// 云端为空，随后本机快照把其它设备较新的设置覆盖掉。
function loadMeta() {
  const openid = getOpenid()
  if (!ready() || !openid) return Promise.resolve(null)
  return db().collection('user_meta').where({ _openid: openid }).limit(1).get()
    .then(r => (r.data && r.data.length ? clean(r.data[0]) : null))
}

// ------------------------------------------------------------- 实时监听
// 监听「当前账号最近写入的一条账单文档」：其它设备新增 / 修改 / 删除（墓碑也是一次写入）都会让它变化，
// 这里只当作变化信号，真正的数据仍走增量拉取（loadCloudBills，按游标只读新文档）。
// onChange(docs) 收到本次变化涉及的文档（已去掉云端内部字段）；onError(err) 表示监听断开，需要调用方重连。
// 返回 { close }；云能力不可用 / 基础库不支持时返回 null（调用方退回轮询）
function watchBills(onChange, onError) {
  const openid = getOpenid()
  if (!ready() || !openid) return null
  return watchQuery(db().collection('bills').where({ _openid: openid }).orderBy('syncedAt', 'desc').limit(1), onChange, onError)
}

// 监听账户 / 预算等设置文档（user_meta，每个账号一份）：另一台设备保存设置后触发，同样只当变化信号
function watchMeta(onChange, onError) {
  const openid = getOpenid()
  if (!ready() || !openid) return null
  return watchQuery(db().collection('user_meta').where({ _openid: openid }), onChange, onError)
}

function watchQuery(q, onChange, onError) {
  try {
    if (typeof q.watch !== 'function') return null
    const w = q.watch({
      onChange(snap) {
        if (!snap || snap.type === 'init') return // 首次快照只是当前状态，不是变化
        const docs = (snap.docChanges || []).map(c => c && c.doc).filter(Boolean).map(clean)
        onChange(docs)
      },
      onError(err) { onError(err) }
    })
    return { close: () => { try { return w.close() } catch (e) { return undefined } } }
  } catch (e) {
    console.warn('[cloud] watch', e)
    return null
  }
}

// ------------------------------------------------------------- 云存储：附件
// 云端路径：attachments/{openid}/{billId}_{attId}.{ext}
// 含账单 id：组合支付会让多笔账单共用同一份附件，各自上传独立副本，
// 这样删除其中一笔账单时不会误删另一笔的文件；同一路径重复上传只会覆盖，不会产生垃圾文件。
function extOf(att) {
  const src = (att.name && att.name.indexOf('.') >= 0) ? att.name : (att.path || '')
  const m = /\.([A-Za-z0-9]{1,8})(?:\?.*)?$/.exec(src)
  return m ? m[1].toLowerCase() : (att.type === 'image' ? 'jpg' : 'bin')
}

function safeSeg(v) {
  return String(v).replace(/[^A-Za-z0-9_-]/g, '_')
}

const uploading = {} // 进行中的上传，避免同一附件并发重复上传

// 上传单个附件，resolve fileID；已有 fileID 的直接返回
function uploadAttachment(att, billId) {
  if (!att) return Promise.reject(new Error('no-attachment'))
  if (att.fileID) return Promise.resolve(att.fileID)
  const openid = getOpenid()
  if (!ready() || !openid) return Promise.reject(new Error('not-logged-in'))
  if (!att.path) return Promise.reject(new Error('no-local-file'))
  const cloudPath = 'attachments/' + safeSeg(openid) + '/' +
    safeSeg(billId || 'misc') + '_' + safeSeg(att.id || Date.now()) + '.' + extOf(att)
  if (uploading[cloudPath]) return uploading[cloudPath]
  const clear = () => { delete uploading[cloudPath] }
  const p = wx.cloud.uploadFile({ cloudPath, filePath: att.path })
    .then(r => {
      clear()
      if (!r || !r.fileID) throw new Error('no-fileID')
      markUploaded()
      return r.fileID
    }, e => { clear(); throw e })
  uploading[cloudPath] = p
  return p
}

// 批量删除云存储文件（单次最多 50 个）；失败只记日志，不影响主流程
function deleteFiles(fileIDs) {
  const ids = (fileIDs || []).filter(Boolean)
  if (!ready() || !isLoggedIn() || !ids.length) return Promise.resolve(false)
  const chunks = []
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50))
  return Promise.all(chunks.map(c => wx.cloud.deleteFile({ fileList: c })))
    .catch(e => { console.warn('[cloud] deleteFile', e); return false })
}

// 把云端附件下载到本地临时文件，resolve 本地路径（用于 openDocument 等只认本地路径的接口）
function downloadAttachment(att) {
  if (!att || !att.fileID) return Promise.reject(new Error('no-fileID'))
  if (!ready()) return Promise.reject(new Error('cloud-not-ready'))
  if (!isLoggedIn()) return Promise.reject(new Error('not-logged-in'))
  return wx.cloud.downloadFile({ fileID: att.fileID }).then(r => r.tempFilePath)
}

// 附件的展示地址：本机文件优先；只有云端副本（fileID）的附件属于云功能，未登录时不显示（返回空串）
function attachmentSrc(att) {
  if (!att) return ''
  if (att.path) return att.path
  return isLoggedIn() && ready() ? (att.fileID || '') : ''
}

function toastNeedLogin() {
  wx.showToast({ title: '登录后可查看云端附件', icon: 'none' })
}

// 打开文件类附件：优先本地文件，本地缺失/打不开时回退到云端下载
function openAttachment(att) {
  const ext = ((att.name || '').split('.').pop() || '').toLowerCase()
  const fail = () => wx.showToast({ title: '无法打开该文件', icon: 'none' })
  const fromCloud = () => {
    if (!att.fileID) { fail(); return }
    if (!isLoggedIn()) { toastNeedLogin(); return }
    wx.showLoading({ title: '下载中...' })
    downloadAttachment(att).then(p => {
      wx.hideLoading()
      wx.openDocument({ filePath: p, fileType: ext, fail })
    }).catch(() => { wx.hideLoading(); fail() })
  }
  if (att.path) wx.openDocument({ filePath: att.path, fileType: ext, fail: fromCloud })
  else fromCloud()
}

// 预览附件：图片用 previewImage（本机路径优先，缺失时用云端 fileID，previewImage 支持云文件 ID）；文件走 openAttachment
function previewAttachment(att, all) {
  if (att.type !== 'image') { openAttachment(att); return }
  if (!attachmentSrc(att)) { toastNeedLogin(); return }
  const src = attachmentSrc
  wx.previewImage({ current: src(att), urls: all.filter(a => a.type === 'image').map(src).filter(Boolean) })
}

// 本机附件文件失效（被清理/回收）而云端有副本时，返回去掉本地路径的新列表（改用 fileID 显示）；无需处理则原样返回
function dropStalePath(list, id) {
  const att = list.find(a => a.id === id)
  if (!att || !att.path || !att.fileID) return list
  return list.map(a => a.id === id ? Object.assign({}, a, { path: '' }) : a)
}

module.exports = {
  CLOUD_ENV, configured, ready, initCloud,
  getSession, getOpenid, isLoggedIn, callFn, login, logout, restoreSession,
  markUploaded, getLastUploadTime,
  syncBill, loadCloudBills,
  syncMeta, loadMeta, watchBills, watchMeta,
  uploadAttachment, deleteFiles, downloadAttachment, extOf, attachmentSrc, openAttachment, previewAttachment, dropStalePath
}
