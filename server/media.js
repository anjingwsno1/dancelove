import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { ApiError, requireThat } from './store.js';
export const MAX_BYTES = 100 * 1024 * 1024;
export function execute(binary, args) {
  return new Promise((resolve,reject) => {
    const child = spawn(binary,args,{windowsHide:true}); let stdout=[];
    const timer=setTimeout(()=>{child.kill();reject(new ApiError(422,'视频处理超时，请换一个视频'));},180000);
    child.stdout.on('data',b=>stdout.push(b)); child.stderr.resume();
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(stdout)):reject(new ApiError(422,'视频格式无法处理，请选择 MP4 或 MOV 视频'));});
  });
}
export async function receive(req, dir) {
  await mkdir(dir,{recursive:true});
  const fields={}; let count=0, tooLarge=false, invalid=false; const writes=[];
  const parser=Busboy({headers:req.headers,limits:{fileSize:MAX_BYTES+1,files:1,fields:8,fieldSize:4096,parts:9}});
  parser.on('file',(name,file)=>{
    count++; if(name!=='video') invalid=true;
    file.on('limit',()=>{tooLarge=true;});
    writes.push(pipeline(file,createWriteStream(join(dir,'input')))); writes.at(-1).catch(()=>{});
  });
  parser.on('field',(name,value,info)=>{if(info.valueTruncated) invalid=true; fields[name]=value;});
  for(const event of ['filesLimit','fieldsLimit','partsLimit']) parser.on(event,()=>{invalid=true;});
  try {
    await pipeline(req,parser); await Promise.all(writes);
    requireThat(!tooLarge,413,'视频不能超过 100MB');
    requireThat(count===1&&!invalid,400,'请上传一个视频，并检查填写内容');
    requireThat((await stat(join(dir,'input'))).size<=MAX_BYTES,413,'视频不能超过 100MB');
    return fields;
  } catch(e) { await Promise.allSettled(writes); await rm(dir,{recursive:true,force:true}); throw e; }
}
export function validateFields(fields, store) {
  const title=(fields.title||'').trim();
  requireThat([...title].length>0&&[...title].length<=8,400,'标题应为 1 至 8 个字');
  const category=store.one('SELECT id FROM categories WHERE id=?',fields.categoryId||'');
  requireThat(category,400,'请选择有效分类');
  requireThat(!store.one('SELECT 1 FROM categories WHERE parent_id=?',category.id),400,'请选择二级分类或没有下级的分类');
  requireThat(['public','private'].includes(fields.visibility),400,'请选择公有或私有');
  let tags; try{tags=JSON.parse(fields.tags||'[]');}catch{throw new ApiError(400,'标签格式错误');}
  requireThat(Array.isArray(tags)&&tags.length>=1&&tags.length<=8&&tags.every(t=>typeof t==='string'&&t.trim().length>0&&[...t.trim()].length<=12),400,'请填写 1 至 8 个标签，每个不超过 12 个字');
  const frame=Number(fields.frame||0); requireThat(Number.isFinite(frame)&&frame>=0,400,'封面时间无效');
  const style=fields.style||'poetry'; requireThat(['poetry','bold','minimal'].includes(style),400,'封面样式无效');
  return {title,tags:[...new Set(tags.map(t=>t.trim()))],categoryId:fields.categoryId,visibility:fields.visibility,frame,style};
}
export async function processVideo(dir, data) {
  const input=join(dir,'input');
  const metadata=JSON.parse((await execute(process.env.FFPROBE_PATH||ffprobe.path,['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov','-show_format','-show_streams','-of','json',input])).toString());
  const video=metadata.streams.find(s=>s.codec_type==='video'&&!s.disposition?.attached_pic);
  const duration=Math.max(Number(metadata.format.duration||0),...metadata.streams.map(s=>Number(s.duration)||0));
  requireThat(video&&Number.isFinite(duration)&&duration>0&&duration<=90,400,'视频实际时长必须大于 0 且不超过 90 秒');
  requireThat(video.width*video.height<=3840*2160,400,'视频分辨率不能超过 4K');
  requireThat(data.frame<duration,400,'封面时间必须小于视频时长');
  const binary=process.env.FFMPEG_PATH||ffmpeg;
  await execute(binary,['-v','error','-nostdin','-y','-protocol_whitelist','file,pipe','-format_whitelist','mov','-i',input,'-map','0:v:0','-map','0:a:0?','-vf',"scale=w='min(720,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-c:v','libx264','-preset','veryfast','-crf','26','-maxrate','1200k','-bufsize','2400k','-pix_fmt','yuv420p','-c:a','aac','-b:a','64k','-movflags','+faststart',join(dir,'video.mp4')]);
  await execute(binary,['-v','error','-nostdin','-y','-ss',String(data.frame),'-i',join(dir,'video.mp4'),'-frames:v','1','-vf','scale=480:-2',join(dir,'cover.jpg')]);
  const pixel=await execute(binary,['-v','error','-i',join(dir,'cover.jpg'),'-vf','scale=1:1','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
  const [r,g,b]=pixel; const luminance=(r*299+g*587+b*114)/1000;
  const color='#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  await rm(input,{force:true});
  return {...data,duration,bytes:(await stat(join(dir,'video.mp4'))).size,color,ink:luminance>150?'#211e29':'#fff5e4'};
}
