import { ApiError, requireThat } from './store.js';

// The AppSecret and WeChat session_key never leave the server.
export async function exchangeWechatCode(code, {
  appId = process.env.WECHAT_APP_ID,
  secret = process.env.WECHAT_APP_SECRET,
  fetchImpl = fetch
} = {}) {
  requireThat(typeof code === 'string' && code.length > 0 && code.length <= 256, 400, '微信登录凭证无效，请重新登录');
  requireThat(appId && secret, 503, '服务端尚未配置微信登录');
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({ appid: appId, secret, js_code: code, grant_type: 'authorization_code' }).toString();
  let result;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    requireThat(response.ok, 502, '微信登录服务暂不可用');
    result = await response.json();
  } catch {
    // Do not log the original error: it may contain the URL and secret.
    throw new ApiError(502, '微信登录服务连接失败，请稍后重试');
  }
  requireThat(!result.errcode && typeof result.openid === 'string' && result.openid.length > 0, 401, '微信登录失败，请重新登录或检查服务端配置');
  return { appId, openid: result.openid };
}
