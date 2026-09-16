const { baseUrl, authMode } = require('../config');
const absolute = path => path ? baseUrl + path : '';
function request(path, method = 'GET', data) {
  return new Promise((resolve, reject) => wx.request({ url: baseUrl + '/api' + path, method, data,
    header: { Authorization: 'Bearer ' + getApp().globalData.token },
    success(res) { if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data); else reject(new Error(res.data.error || '请求失败')); },
    fail() { reject(new Error('无法连接服务，请检查后端地址与网络')); }
  }));
}
async function login(account) {
  let result;
  if (authMode === 'wechat') {
    const code = await new Promise((resolve,reject) => wx.login({ success: r => r.code ? resolve(r.code) : reject(new Error('微信登录失败，请重试')), fail: () => reject(new Error('微信登录失败，请重试')) }));
    result = await request('/auth/wechat', 'POST', { code });
  } else { result = await request('/demo/login', 'POST', { account }); wx.setStorageSync('account', account); }
  getApp().globalData.token=result.token; getApp().globalData.user=result.user;
  return result;
}
let loginPromise;
async function ensureLogin() {
  if(getApp().globalData.token)return;
  if(!loginPromise)loginPromise=login(wx.getStorageSync('account') || 'student').finally(()=>{loginPromise=null;});
  await loginPromise;
}
const error = e => wx.showToast({ title: e.message || '操作失败', icon: 'none', duration: 3000 });
const video = v => Object.assign({}, v, { coverUrl: absolute(v.coverUrl), playUrl: absolute(v.playUrl), durationText: Math.floor(v.duration / 60) + ':' + String(Math.floor(v.duration % 60)).padStart(2, '0'), statusText: { pending: '待审核', approved: '已通过', rejected: '未通过' }[v.status] });
module.exports = { request, login, ensureLogin, error, video, absolute, baseUrl, authMode };
