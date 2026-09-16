const api=require('../../utils/api');
Page({
  data:{quota:{},amount:10,custom:'',busy:false,orders:[],error:''},
  async onLoad(){try{await api.ensureLogin();await this.load();}catch(e){api.error(e);}},
  async load(){try{const me=await api.request('/me'),orders=await api.request('/orders');this.setData({quota:me.quota,orders:orders.map(o=>Object.assign({},o,{yuan:o.amount_fen/100,date:o.created_at.slice(0,10)})),error:''});}catch(e){this.setData({error:e.message});}},
  amount(e){this.setData({amount:Number(e.currentTarget.dataset.amount),custom:''});},
  custom(e){this.setData({custom:e.detail.value,amount:Number(e.detail.value)});},
  async pay(){if(this.data.busy)return;const amount=this.data.amount;if(!Number.isSafeInteger(amount)||amount<1||amount>10000)return api.error(new Error('请输入 1 至 10000 的整数金额'));this.setData({busy:true});try{const order=await api.request('/orders','POST',{amountYuan:amount});await api.request('/orders/'+order.id+'/demo-pay','POST',{});wx.showToast({title:'模拟充值成功'});await this.load();}catch(e){api.error(e);}finally{this.setData({busy:false});}},
  async resume(e){if(this.data.busy)return;this.setData({busy:true});try{await api.request('/orders/'+e.currentTarget.dataset.id+'/demo-pay','POST',{});await this.load();wx.showToast({title:'模拟支付成功'});}catch(e){api.error(e);}finally{this.setData({busy:false});}}
});
