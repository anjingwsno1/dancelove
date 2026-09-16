const api = require('../../utils/api');
Page({
  data: { scope: 'public', categories: [], allCategories: [], category: '', q: '', items: [], loading: false, error: '', page: 1, hasMore: false, total: 0, user: {}, accounts: ['林同学 · 学员', '许老师 · 老师', '管理员', '陈同学 · 学员'], accountIndex: 0, demo: api.authMode !== 'wechat', managedCategories: [], categoryName: '', parentIndex: 0, parentChoices: [{id:'',name:'一级分类'}], editingId: '', categoryBusy: false, deleting: null, moveTargets: [], moveIndex: -1 },
  async onLoad() { try { await api.ensureLogin(); this.setData({ accountIndex: ['student','teacher','admin','student2'].indexOf(wx.getStorageSync('account') || 'student') }); await this.refresh(); } catch(e) { this.setData({ error: e.message }); } },
  async onShow() { if (getApp().globalData.token) await this.refresh(); },
  async refresh() { try { const me = await api.request('/me'),allCategories=await api.request('/categories'),categories=allCategories.filter(c=>!c.parentId),parentChoices=[{id:'',name:'一级分类'}].concat(allCategories.filter(c=>!c.parentId)); this.setData({ user: me.user, quota: me.quota, allCategories, categories, parentChoices, category: allCategories.some(c=>c.id===this.data.category)?this.data.category:'' }); if(this.data.scope==='categories'&&me.user.role!=='admin')this.setData({scope:'public'}); if(this.data.scope==='categories')await this.loadCategories();else await this.load(false); } catch(e) { this.setData({ error: e.message }); } },
  async load(append) { const revision=this.revision=(this.revision||0)+1; this.setData({ loading: true, error: '' }); try { const page = append ? this.data.page + 1 : 1; const result = await api.request('/videos?scope=' + this.data.scope + '&category=' + this.data.category + '&q=' + encodeURIComponent(this.data.q) + '&page=' + page); if(revision!==this.revision)return; this.setData({ items: append ? this.data.items.concat(result.items.map(api.video)) : result.items.map(api.video), page, total: result.total, hasMore: result.hasMore }); } catch(e) { this.setData({ error: e.message }); } finally { if(revision===this.revision)this.setData({ loading: false }); } },
  async switchAccount(e) { try { const index=Number(e.detail.value); await api.login(['student','teacher','admin','student2'][index]); this.setData({ accountIndex: index, scope: 'public' }); await this.refresh(); } catch(e) { api.error(e); } },
  changeScope(e) { this.setData({ scope: e.currentTarget.dataset.scope }); if(this.data.scope==='categories')this.loadCategories();else this.load(false); },
  changeCategory(e) { this.setData({ category: e.currentTarget.dataset.id }); this.load(false); },
  search(e) { this.setData({ q: e.detail.value }); clearTimeout(this.searchTimer); this.searchTimer=setTimeout(()=>this.load(false),300); },
  onUnload() { clearTimeout(this.searchTimer); },
  async onPullDownRefresh() { await this.refresh(); wx.stopPullDownRefresh(); },
  onReachBottom() { if(this.data.scope!=='categories'&&this.data.hasMore&&!this.data.loading)this.load(true); },
  open(e) { wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id + (this.data.scope === 'review' ? '&review=1' : '') }); },
  upload() { wx.navigateTo({ url: '/pages/upload/upload' }); },
  async retry() { try { getApp().globalData.token=''; await api.ensureLogin(); await this.refresh(); } catch(e) { this.setData({error:e.message}); } },
  copyId() { wx.setClipboardData({data:this.data.user.id}); },
  async loadCategories() { try { this.setData({managedCategories:await api.request('/categories?manage=1'),error:''}); } catch(e) { this.setData({error:e.message}); } },
  categoryInput(e) { this.setData({categoryName:e.detail.value}); },
  parentChange(e) { this.setData({parentIndex:Number(e.detail.value)}); },
  editCategory(e) { const c=this.data.managedCategories.find(c=>c.id===e.currentTarget.dataset.id); if(c)this.setData({editingId:c.id,categoryName:c.name,parentIndex:Math.max(0,this.data.parentChoices.findIndex(p=>p.id===(c.parentId||'')))}); },
  cancelEdit() { this.setData({editingId:'',categoryName:'',parentIndex:0}); },
  async saveCategory() {
    if(this.data.categoryBusy)return;
    if(!this.data.categoryName.trim())return api.error(new Error('请输入分类名称'));
    this.setData({categoryBusy:true});
    try { const parent=this.data.parentChoices[this.data.parentIndex]; await api.request('/categories'+(this.data.editingId?'/'+this.data.editingId:''),this.data.editingId?'PATCH':'POST',{name:this.data.categoryName,parentId:parent?parent.id:null}); this.cancelEdit(); await this.refresh(); wx.showToast({title:'分类已保存'}); } catch(e) { api.error(e); } finally { this.setData({categoryBusy:false}); }
  },
  deleteCategory(e) { const c=this.data.managedCategories.find(c=>c.id===e.currentTarget.dataset.id); if(!c)return;if(c.childrenCount)return api.error(new Error('请先删除或移动该一级分类下的二级分类'));this.setData({deleting:c,moveTargets:this.data.managedCategories.filter(x=>x.id!==c.id&&!x.childrenCount),moveIndex:-1}); },
  cancelDelete() { if(!this.data.categoryBusy)this.setData({deleting:null}); },
  moveTarget(e) { this.setData({moveIndex:Number(e.detail.value)}); },
  async confirmDelete() {
    if(this.data.categoryBusy||!this.data.deleting)return;
    if(this.data.deleting.videoCount>0&&this.data.moveIndex<0)return api.error(new Error('请选择视频转移分类'));
    this.setData({categoryBusy:true});
    try { const target=this.data.moveTargets[this.data.moveIndex]; await api.request('/categories/'+this.data.deleting.id,'DELETE',{moveTo:target?target.id:undefined}); this.setData({deleting:null}); this.cancelEdit(); await this.refresh(); wx.showToast({title:'分类已删除'}); } catch(e) { api.error(e); } finally { this.setData({categoryBusy:false}); }
  }
});
