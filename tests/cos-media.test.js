import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMediaStorage } from '../server/cos-media.js';

test('COS reads return streams and forward byte ranges in request headers',async()=>{
  const requests=[];
  class FakeCos {
    headObject(options,callback){requests.push(['head',options]);callback(null,{headers:{'content-length':'6'}});}
    getObjectStream(options){requests.push(['get',options]);return Readable.from([Buffer.from(options.Headers.Range==='bytes=2-4'?'cde':'ef')]);}
  }
  const env={MEDIA_PROVIDER:'cos',COS_SECRET_ID:'id',COS_SECRET_KEY:'key',COS_BUCKET:'bucket',COS_REGION:'region'};
  const storage=createMediaStorage('unused',env,FakeCos);
  const part=await storage.read('video','video.mp4',{start:2,end:4});
  assert.equal(part.size,6);
  assert.equal(Buffer.concat(await Array.fromAsync(part.stream)).toString(),'cde');
  assert.equal(requests[1][1].Headers.Range,'bytes=2-4');
  const suffix=await storage.read('video','video.mp4',{suffix:2});
  assert.equal(Buffer.concat(await Array.fromAsync(suffix.stream)).toString(),'ef');
  assert.equal(requests[3][1].Headers.Range,'bytes=-2');
  await storage.head('video','video.mp4');
  assert.equal(requests.filter(([method])=>method==='get').length,2);
});
