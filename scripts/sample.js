import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { execute } from '../server/media.js';
// Synthetic test pattern, never presented as a real dance video.
await mkdir('test-results',{recursive:true});
const target=resolve('test-results/sample.mp4');
await execute(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=480x640:rate=24','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-y',target]);
console.log(target);
