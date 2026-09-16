const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const state={token:localStorage.getItem('danceToken'),view:'public',category:'',q:'',page:1,items:[],editingCategory:''};
const labels={public:'发现舞蹈',mine:'我的作品',favorites:'我的收藏',review:'审核工作台',categories:'分类管理'};
const statuses={pending:'待审核',approved:'已通过',rejected:'未通过'};
const commonTags=['舞蹈日常','基本功','零基础','舞台练习'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message){$('#toast').textContent=message;$('#toast').style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').style.display='none',3500);}
async function api(path,method='GET',data){const res=await fetch('/api'+path,{method,headers:{Authorization:`Bearer ${state.token}`,...(data instanceof FormData?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:data instanceof FormData?data:JSON.stringify(data)});const value=await res.json();if(!res.ok)throw new Error(value.error);return value;}
function guard(fn){return async(...args)=>{try{await fn(...args);}catch(e){toast(e.message);}};}
async function refreshMe(){state.me=await api('/me');$('#reviewNav').hidden=state.me.user.role!=='admin';$('#categoryNav').hidden=state.me.user.role!=='admin';const q=state.me.quota;$('#quotaSummary').textContent=`今日剩余免费次数：${q.freeRemaining??'不限'} · 额外次数：${q.credits} · 学员每天 1 次 / 老师每天 2 次 / 管理员不限`;}
async function login(account){const value=await api('/demo/login','POST',{account});state.token=value.token;localStorage.setItem('danceToken',value.token);localStorage.setItem('danceAccount',account);await refreshMe();await refreshCategories();await load();}
async function load(append=false){
  const revision=state.revision=(state.revision||0)+1;
  $('#breadcrumb').textContent=labels[state.view];$('#library').hidden=state.view==='categories';$('#categoryManager').hidden=state.view!=='categories';
  $$('#nav button').forEach(b=>b.classList.toggle('selected',b.dataset.view===state.view));
  if(state.view==='categories'){await manageCategories();return;}
  $('#viewTitle').innerHTML=`${labels[state.view]} <span id="total">…</span>`;
  const result=await api('/videos?'+new URLSearchParams({scope:state.view,category:state.category,q:state.q,page:state.page}));if(revision!==state.revision)return;
  state.items=append?[...state.items,...result.items]:result.items;$('#total').textContent=result.total;$('#more').hidden=!result.hasMore;
  $('#cards').innerHTML=state.items.length?state.items.map(v=>`<button class="card" data-id="${v.id}"><div class="cover" style="background:${esc(v.color)}">${v.coverUrl?`<img src="${esc(v.coverUrl)}" loading="lazy" alt="${esc(v.title)}的封面">`:''}<span class="visibility">${v.visibility==='private'?'仅自己可见':esc(v.categoryName)}</span><span class="duration">${Math.floor(v.duration/60)}:${String(Math.floor(v.duration%60)).padStart(2,'0')}</span><span class="cover-title ${esc(v.style)}" style="color:${esc(v.ink)}">${esc(v.title)}</span></div><div class="card-info"><b>${esc(v.title)}</b><span>♡ ${v.likes}</span></div><p>${esc(v.ownerName)} · ${v.status==='approved'?esc(v.tags.map(t=>'#'+t).join(' ')):statuses[v.status]}</p></button>`).join(''):`<div class="empty"><div class="symbol">✧</div><h3>${state.q?'还没有找到这段舞蹈':state.view==='review'?'待审作品已全部处理':'这里，等待一段新的舞蹈'}</h3><p>${state.q?'试试其他标题或标签':state.view==='public'?'上传第一段作品，审核后将在这里相遇。':'你的作品与收藏，会在这里好好保存。'}</p></div>`;
}
async function detail(id){
  const v=await api(`/videos/${id}${state.view==='review'?'?review=1':''}`);state.detail=v;$('#detailTitle').textContent=v.title;
  $('#detailContent').innerHTML=`${v.playUrl?`<video class="detail-video" src="${esc(v.playUrl)}" poster="${esc(v.coverUrl)}" controls playsinline preload="none"></video>`:`<div class="empty"><h3>${statuses[v.status]}</h3><p>${esc(v.reason||'等待管理员审核，暂不可观看、下载或互动。')}</p></div>`}<div class="tags">${esc(v.tags.map(t=>'#'+t).join('　'))}</div><p class="muted">${esc(v.ownerName)} · ${esc(v.categoryName)} · ${v.visibility==='private'?'仅自己可见':'公有'} · ${v.duration.toFixed(1)} 秒</p><div class="actions">${state.view==='review'?'<button class="primary" data-review="approved">通过审核</button><button class="secondary" data-review="rejected">驳回并填写原因</button>':v.status==='approved'?`<button class="secondary ${v.liked?'active':''}" data-reaction="like">${v.liked?'♥ 已点赞':'♡ 点赞'} ${v.likes}</button><button class="secondary ${v.favorited?'active':''}" data-reaction="favorite">${v.favorited?'★ 已收藏':'☆ 收藏'}</button><button class="secondary" id="download">↓ 下载视频</button>`:''}</div>`;
  if(!$('#detailDialog').open)$('#detailDialog').showModal();
}
async function refreshCategories(){
  const categories=await api('/categories');state.categories=categories;
  if(!categories.some(c=>c.id===state.category))state.category='';
  const roots=categories.filter(c=>!c.parentId),leaves=categories.filter(c=>!c.childrenCount);
  $('#categories').innerHTML='<button class="'+(!state.category?'selected':'')+'" data-id="">全部</button>'+roots.map(c=>`<button class="${state.category===c.id?'selected':''}" data-id="${c.id}">${esc(c.name)}</button>`).join('');
  const selected=$('#uploadCategory').value;
  $('#uploadCategory').innerHTML='<option value="">请选择分类</option>'+leaves.map(c=>`<option value="${c.id}">${esc(c.displayName||c.name)}</option>`).join('');
  $('#uploadCategory').value=leaves.some(c=>c.id===selected)?selected:'';
}
async function manageCategories(){
  const categories=await api('/categories?manage=1');state.managedCategories=categories;
  $('#categoryParent').innerHTML='<option value="">一级分类</option>'+categories.filter(c=>!c.parentId).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#categoryList').innerHTML=categories.map(c=>`<div class="category-row ${c.parentId?'child-category':''}"><div><b>${esc(c.parentId?'└ '+c.name:c.name)}</b><p class="muted">${c.videoCount} 个视频${c.childrenCount?' · '+c.childrenCount+' 个二级分类':''}</p></div><div class="actions"><button class="secondary" data-edit-category="${c.id}">修改</button><button class="secondary danger" data-delete-category="${c.id}">删除</button></div></div>`).join('');
}
function resetCategoryForm(){state.editingCategory='';$('#categoryName').value='';$('#categoryParent').value='';$('#categoryParent').disabled=false;$('#categoryFormLabel').textContent='创建新分类';$('#saveCategory').textContent='创建分类';$('#cancelCategory').hidden=true;}
$('#categoryForm').onsubmit=guard(async e=>{e.preventDefault();const b=$('#saveCategory');b.disabled=true;try{await api('/categories'+(state.editingCategory?'/'+state.editingCategory:''),state.editingCategory?'PATCH':'POST',{name:$('#categoryName').value,parentId:$('#categoryParent').value||null});resetCategoryForm();await refreshCategories();await manageCategories();toast('分类已保存');}finally{b.disabled=false;}});
$('#cancelCategory').onclick=resetCategoryForm;
$('#categoryList').onclick=guard(async e=>{
  const button=e.target.closest('button');if(!button)return;
  const id=button.dataset.editCategory||button.dataset.deleteCategory;
  const c=state.managedCategories.find(c=>c.id===id);if(!c)return;
  if(button.dataset.editCategory){state.editingCategory=id;$('#categoryName').value=c.name;$('#categoryParent').value=c.parentId||'';$('#categoryParent').disabled=!!c.childrenCount;$('#categoryFormLabel').textContent='修改分类';$('#saveCategory').textContent='保存修改';$('#cancelCategory').hidden=false;$('#categoryName').focus();return;}
  if(c.childrenCount){toast('请先删除或移动该一级分类下的二级分类');return;}
  state.deletingCategory=c;$('#deleteCategoryTitle').textContent=`删除「${c.name}」？`;
  $('#moveCategoryLabel').hidden=!c.videoCount;$('#moveCategory').required=!!c.videoCount;
  $('#moveCategory').innerHTML='<option value="">请选择目标分类</option>'+state.managedCategories.filter(x=>x.id!==id&&!x.childrenCount).map(x=>`<option value="${x.id}">${esc(x.displayName||x.name)}</option>`).join('');
  $('#deleteCategoryDialog').showModal();
});
$('#deleteCategoryForm').onsubmit=guard(async e=>{e.preventDefault();const b=$('#confirmDeleteCategory');b.disabled=true;try{await api('/categories/'+state.deletingCategory.id,'DELETE',{moveTo:$('#moveCategory').value||undefined});$('#deleteCategoryDialog').close();resetCategoryForm();await refreshCategories();await manageCategories();toast('分类已删除，视频已保留');}finally{b.disabled=false;}});
$('#account').addEventListener('change',guard(async e=>{state.view='public';state.page=1;await login(e.target.value);}));
$('#nav').addEventListener('click',guard(async e=>{const button=e.target.closest('[data-view]');if(!button)return;state.view=button.dataset.view;state.page=1;await load();}));
$('#categories').addEventListener('click',guard(async e=>{const b=e.target.closest('button');if(!b)return;state.category=b.dataset.id;state.page=1;$$('#categories button').forEach(x=>x.classList.toggle('selected',x===b));await load();}));
$('#search').addEventListener('input',()=>{clearTimeout(state.searchTimer);state.searchTimer=setTimeout(guard(async()=>{state.q=$('#search').value.trim();state.page=1;await load();}),250);});
$('#cards').addEventListener('click',guard(async e=>{const b=e.target.closest('[data-id]');if(b)await detail(b.dataset.id);}));
$('#more').onclick=guard(async()=>{state.page++;await load(true);});
$$('[data-close]').forEach(b=>b.onclick=()=>$('#'+b.dataset.close).close());
$('#detailDialog').addEventListener('close',()=>{$('#detailContent video')?.pause();});
$('#detailContent').addEventListener('click',guard(async e=>{const b=e.target.closest('button');if(!b)return;const v=state.detail;b.disabled=true;try{if(b.dataset.reaction){const kind=b.dataset.reaction;await api(`/videos/${v.id}/${kind}`,'PUT',{active:kind==='like'?!v.liked:!v.favorited});await detail(v.id);await load();}else if(b.id==='download'){const {url}=await api(`/videos/${v.id}/download`,'POST',{});const a=document.createElement('a');a.href=url;a.download=`${v.title}.mp4`;a.click();}else if(b.dataset.review){let reason='';if(b.dataset.review==='rejected'){reason=prompt('请输入驳回原因（必填，最多 200 字）');if(reason===null)return;}await api(`/videos/${v.id}/review`,'POST',{decision:b.dataset.review,reason});$('#detailDialog').close();toast('审核结果已保存');await load();}}finally{b.disabled=false;}}));
$('#openUpload').onclick=guard(async()=>{await refreshCategories();$('#uploadDialog').showModal();});
$('#file').onchange=guard(async()=>{const file=$('#file').files[0];if(!file)return;if(file.size>100*1024*1024){$('#file').value='';throw new Error('视频不能超过 100MB');}if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);state.objectUrl=URL.createObjectURL(file);$('#preview').src=state.objectUrl;$('#frameBox').hidden=false;$('#frame').value=0;$('#frameLabel').textContent='0.0 秒';});
$('#preview').onloadedmetadata=()=>{const d=$('#preview').duration;if(!Number.isFinite(d)||d>90){$('#file').value='';$('#frameBox').hidden=true;toast('视频不能超过 90 秒');return;}$('#frame').max=Math.max(0,d-.1);};
$('#frame').oninput=()=>{$('#preview').currentTime=Number($('#frame').value);$('#frameLabel').textContent=Number($('#frame').value).toFixed(1)+' 秒';};
function previewTitle(){$('#previewTitle').textContent=$('#title').value||'舞动此刻';$('#previewTitle').className='cover-title '+$('#coverStyle').value;}
$('#title').oninput=previewTitle;$('#coverStyle').onchange=previewTitle;
$('#uploadForm').onsubmit=guard(async e=>{e.preventDefault();const file=$('#file').files[0];if(!file)throw new Error('请选择视频');const form=new FormData(e.target);form.set('tags',JSON.stringify(String(form.get('tags')).split(/[,，\s]+/).filter(Boolean)));form.set('frame',$('#frame').value);form.set('video',file);$('#submitUpload').disabled=true;$('#uploadStatus').textContent='正在上传并处理视频，请保持页面打开…';try{await api('/videos','POST',form);e.target.reset();$('#frameBox').hidden=true;$('#uploadDialog').close();toast('已提交审核');state.view='mine';state.page=1;await refreshMe();await load();}finally{$('#submitUpload').disabled=false;$('#uploadStatus').textContent='';}});
$('#commonTags').innerHTML=commonTags.map(tag=>`<button type="button" data-tag="${tag}">+ ${tag}</button>`).join('');
$('#commonTags').onclick=e=>{const button=e.target.closest('[data-tag]');if(!button)return;const tags=$('#tags').value.split(/[,，\s]+/).filter(Boolean);if(tags.includes(button.dataset.tag))return;if(tags.length>=8){toast('最多 8 个标签');return;}$('#tags').value=[...tags,button.dataset.tag].join('，');};
await guard(async()=>{const health=await api('/health');if(health.mode!=='demo'){$('#account').hidden=true;$('#openUpload').disabled=true;throw new Error('请使用微信小程序登录，浏览器演示入口已关闭');}const account=localStorage.getItem('danceAccount')||'student';$('#account').value=account;await login(account);})();
