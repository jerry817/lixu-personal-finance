// packages/excel/zip.js
// 最小 ZIP 写入器（只存储、不压缩）：xlsx 与图片本身已是压缩格式，再压一遍几乎没有收益。
// 纯函数：不碰 wx，可以直接在 node 里测试。文件名按 UTF-8 写入（通用标志位 bit 11），中文文件名在常见解压工具里不会乱码。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function utf8(str) {
  const bin = unescape(encodeURIComponent(str))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// files: [{ name, data: ArrayBuffer | Uint8Array }] → ArrayBuffer
function zipBuffer(files) {
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const entries = files.map(f => {
    const data = new Uint8Array(f.data)
    return { name: utf8(f.name), data, crc: crc32(data) }
  })

  const local = e => 30 + e.name.length + e.data.length
  const central = e => 46 + e.name.length
  const cdSize = entries.reduce((n, e) => n + central(e), 0)
  const total = entries.reduce((n, e) => n + local(e), 0) + cdSize + 22
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)
  let p = 0
  const u16 = v => { view.setUint16(p, v, true); p += 2 }
  const u32 = v => { view.setUint32(p, v, true); p += 4 }
  const bytes = b => { buf.set(b, p); p += b.length }

  const offsets = entries.map(e => {
    const at = p
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate)
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0)
    bytes(e.name); bytes(e.data)
    return at
  })
  const cdStart = p
  entries.forEach((e, i) => {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate)
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length)
    u16(0); u16(0); u16(0); u16(0); u32(0); u32(offsets[i])
    bytes(e.name)
  })
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length); u32(cdSize); u32(cdStart); u16(0)
  return buf.buffer
}

module.exports = { zipBuffer }
