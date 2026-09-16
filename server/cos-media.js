import COS from 'cos-nodejs-sdk-v5';
import { createReadStream } from 'node:fs';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, requireThat } from './store.js';

// 视频处理必须在本地临时目录完成；成品才会进入对象存储。
export function createMediaStorage(dataDir, env = process.env) {
  const provider = env.MEDIA_PROVIDER || 'local';
  const root = join(dataDir, 'media');
  const stagingRoot = join(dataDir, 'staging');
  if (provider === 'local') return {
    async staging(id) { const dir = join(root, id); await mkdir(dir, { recursive: true }); return dir; },
    async publish() {},
    async remove(id) { await rm(join(root, id), { recursive: true, force: true }); },
    async read(id, file, range) {
      const path = join(root, id, file); const info = await stat(path);
      return { size: info.size, stream: createReadStream(path, range ? { start: range.start, end: range.end } : undefined) };
    }
  };
  requireThat(provider === 'cos', 500, 'MEDIA_PROVIDER 只能是 local 或 cos');
  for (const key of ['COS_SECRET_ID','COS_SECRET_KEY','COS_BUCKET','COS_REGION']) requireThat(env[key], 500, `缺少 ${key} 配置`);
  const cos = new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY });
  const prefix = (env.COS_PREFIX || 'dancelove').replace(/^\/+|\/+$/g, '');
  const key = (id, file) => `${prefix}/videos/${id}/${file}`;
  const request = (method, options) => new Promise((resolve, reject) => cos[method](options, (err, data) => err ? reject(err) : resolve(data)));
  return {
    async staging(id) { const dir = join(stagingRoot, id); await mkdir(dir, { recursive: true }); return dir; },
    async publish(id, dir) {
      await Promise.all(['video.mp4','cover.jpg'].map(async file => {
        await access(join(dir, file));
        await request('putObject', { Bucket: env.COS_BUCKET, Region: env.COS_REGION, Key: key(id, file), Body: createReadStream(join(dir, file)), ContentType: file === 'cover.jpg' ? 'image/jpeg' : 'video/mp4' });
      }));
      await rm(dir, { recursive: true, force: true });
    },
    async remove(id) { await Promise.all(['video.mp4','cover.jpg'].map(file => request('deleteObject', { Bucket: env.COS_BUCKET, Region: env.COS_REGION, Key: key(id, file) }).catch(() => {}))); },
    async read(id, file, range) {
      const data = await request('getObject', { Bucket: env.COS_BUCKET, Region: env.COS_REGION, Key: key(id, file), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) });
      const size = Number(String(data.headers?.['content-length'] || 0));
      return { size, stream: data.Body, headers: data.headers };
    }
  };
}
