// 云函数 login：返回调用者的 openid（由云开发运行时注入，不可伪造）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  return { openid: OPENID }
}
