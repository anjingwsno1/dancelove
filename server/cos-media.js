import COS from 'cos-nodejs-sdk-v5';
import { createReadStream } from 'node:fs';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, requireThat } from './store.js';

// 视频处理必须在本地临时目录完成；成品才会进入对象存储。
export function createMediaStorage(dataDir, env = process.env, CosClient = COS) {
  const provider = env.MEDIA_PROVIDER || 'local';
  const root = join(dataDir, 'media');
  const stagingRoot = join(dataDir, 'staging');
  if (provider === 'local') return {
    async staging(id) { const dir = join(root, id); await mkdir(dir, { recursive: true }); return dir; },
    async publish() {},
    async remove(id) { await rm(join(root, id), { recursive: true, force: true }); },
    async head(id, file) { return { size: (await stat(join(root, id, file))).size }; },
    async read(id, file, range) {
      const path = join(root, id, file); const info = await stat(path);
      const options = range ? { start: range.suffix === undefined ? range.start : Math.max(0, info.size - range.suffix), end: range.end } : undefined;
      return { size: info.size, stream: createReadStream(path, options) };
    }
  };
  requireThat(provider === 'cos', 500, 'MEDIA_PROVIDER 只能是 local 或 cos');
  for (const key of ['COS_SECRET_ID','COS_SECRET_KEY','COS_BUCKET','COS_REGION']) requireThat(env[key], 500, `缺少 ${key} 配置`);
  const cos = new CosClient({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY });
  const prefix = (env.COS_PREFIX || 'dancelove').replace(/^\/+|\/+$/g, '');
  const key = (id, file) => `${prefix}/videos/${id}/${file}`;
  const request = (method, options) => new Promise((resolve, reject) => cos[method](options, (err, data) => err ? reject(err) : resolve(data)));
  const head = async (id, file) => {
    const info = await request('headObject', { Bucket: env.COS_BUCKET, Region: env.COS_REGION, Key: key(id, file) });
    return { size: Number(info.headers['content-length']) };
  };
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
    head,
    async read(id, file, range) {
      const options = { Bucket: env.COS_BUCKET, Region: env.COS_REGION, Key: key(id, file) };
      const { size } = await head(id, file);
      const rangeHeader = range && (range.suffix === undefined ? `bytes=${range.start}-${range.end ?? ''}` : `bytes=-${range.suffix}`);
      const stream = cos.getObjectStream({ ...options, Headers: rangeHeader ? { Range: rangeHeader } : {} }, () => {});
      return { size, stream };
    }
  };
}
