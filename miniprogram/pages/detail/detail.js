const api=require('../../utils/api');
Page({
  data:{video:null,review:false,busy:false,error:'',reason:''},
  async onLoad(options){this.id=options.id;this.setData({review:options.review==='1'});await this.load();},
  async load(){try{await api.ensureLogin();const v=await api.request('/videos/'+this.id+(this.data.review?'?review=1':''));this.setData({video:api.video(v),error:''});}catch(e){this.setData({error:e.message});}},
  async reaction(e){if(this.data.busy)return;this.setData({busy:true});try{const kind=e.currentTarget.dataset.kind,v=this.data.video;const updated=await api.request('/videos/'+this.id+'/'+kind,'PUT',{active:kind==='like'?!v.liked:!v.favorited});this.setData({video:api.video(updated)});}catch(e){api.error(e);}finally{this.setData({busy:false});}},
  async download(){if(this.data.busy)return;this.setData({busy:true});wx.showLoading({title:'正在下载'});try{const result=await api.request('/videos/'+this.id+'/download','POST',{});const file=await new Promise((resolve,reject)=>wx.downloadFile({url:api.absolute(result.url),success:r=>r.statusCode===200?resolve(r):reject(new Error('下载失败，请刷新重试')),fail:()=>reject(new Error('下载失败，请检查网络'))}));await new Promise((resolve,reject)=>wx.saveVideoToPhotosAlbum({filePath:file.tempFilePath,success:resolve,fail:()=>reject(new Error('无法保存，请在小程序设置中允许保存到相册'))}));wx.showToast({title:'已保存到相册'});}catch(e){api.error(e);}finally{wx.hideLoading();this.setData({busy:false});}},
  reason(e){this.setData({reason:e.detail.value});},
  async review(e){if(this.data.busy)return;const decision=e.currentTarget.dataset.decision;if(decision==='rejected'&&!this.data.reason.trim())return api.error(new Error('驳回时请填写原因'));this.setData({busy:true});try{await api.request('/videos/'+this.id+'/review','POST',{decision,reason:this.data.reason});wx.showModal({title:'审核已保存',content:decision==='approved'?'视频已通过审核。':'视频已驳回，上传者可查看原因。',showCancel:false,success:()=>wx.navigateBack()});}catch(e){api.error(e);}finally{this.setData({busy:false});}},
  retry(){this.load();},
  playbackError(){api.error(new Error('播放失败或链接过期，请点击刷新'));},
  openSettings(){wx.openSetting({});}
});
