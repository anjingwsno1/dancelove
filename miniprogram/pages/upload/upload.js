const api=require('../../utils/api');
Page({
  data:{file:'',title:'',tags:'',commonTags:['舞蹈日常','基本功','零基础','舞台练习'],categories:[],categoryIndex:-1,visibilityIndex:0,visibilities:['公有 · 审核后所有人可搜索','私有 · 审核后仅自己可见'],styles:['诗意 · 衬线','律动 · 粗体','留白 · 简约'],styleIndex:0,styleName:'poetry',duration:0,frame:0,frameMax:0,busy:false,progress:0},
  async onLoad(){try{await api.ensureLogin();this.setData({categories:(await api.request('/categories')).filter(c=>!c.childrenCount)});}catch(e){api.error(e);}},
  choose(){wx.chooseMedia({count:1,mediaType:['video'],sourceType:['album','camera'],maxDuration:90,success:res=>{const f=res.tempFiles[0];if(f.size>100*1024*1024)return api.error(new Error('视频不能超过 100MB'));if(!f.duration||f.duration>90)return api.error(new Error('视频不能超过 90 秒'));this.setData({file:f.tempFilePath,duration:f.duration,frame:0,frameMax:Math.max(0,Math.floor((f.duration-.1)*10)/10)});},fail:e=>{if(!e.errMsg.includes('cancel'))api.error(new Error('无法读取视频'));}});},
  input(e){this.setData({[e.currentTarget.dataset.field]:e.detail.value});},
  addTag(e){const tag=e.currentTarget.dataset.tag,tags=this.data.tags.split(/[,，\s]+/).filter(Boolean);if(tags.includes(tag))return;if(tags.length>=8)return api.error(new Error('最多 8 个标签'));this.setData({tags:tags.concat(tag).join('，')});},
  category(e){this.setData({categoryIndex:Number(e.detail.value)});},
  visibility(e){this.setData({visibilityIndex:Number(e.detail.value)});},
  style(e){const n=Number(e.detail.value);this.setData({styleIndex:n,styleName:['poetry','bold','minimal'][n]});},
  frame(e){const frame=e.detail.value/10;this.setData({frame});const ctx=wx.createVideoContext('preview',this);ctx.seek(frame);ctx.pause();},
  submit(){
    if(this.data.busy)return;
    const d=this.data,tags=d.tags.split(/[,，\s]+/).filter(Boolean);
    if(!d.file)return api.error(new Error('请选择视频'));
    if(!d.title.trim()||[...d.title.trim()].length>8)return api.error(new Error('标题应为 1 至 8 个字'));
    if(d.categoryIndex<0)return api.error(new Error('请选择分类'));
    if(!tags.length||tags.length>8||tags.some(t=>[...t].length>12))return api.error(new Error('请填写 1 至 8 个标签，每个最多 12 个字'));
    this.setData({busy:true,progress:0});
    this.task=wx.uploadFile({url:api.baseUrl+'/api/videos',filePath:d.file,name:'video',timeout:240000,header:{Authorization:'Bearer '+getApp().globalData.token},formData:{title:d.title.trim(),tags:JSON.stringify(tags),categoryId:d.categories[d.categoryIndex].id,visibility:d.visibilityIndex===0?'public':'private',frame:String(d.frame),style:d.styleName},success:res=>{try{const result=JSON.parse(res.data);if(res.statusCode!==201)throw new Error(result.error||'上传失败');wx.showModal({title:'已提交审核',content:'管理员审核通过后，即可观看、点赞、收藏和下载。',showCancel:false,success:()=>wx.navigateBack()});}catch(e){api.error(e);}},fail:()=>api.error(new Error('上传中断，请在“我的作品”确认是否已提交后再重试')),complete:()=>this.setData({busy:false})});
    this.task.onProgressUpdate(res=>this.setData({progress:res.progress}));
  }
});
