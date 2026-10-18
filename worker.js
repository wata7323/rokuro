// 10秒暴走ろくろ：番付（ランキング）とプレイ数の API。それ以外のパスは静的ファイル（index.html など）をそのまま返す
//   GET  /api/rank            → {list:[{id,n,p,r,k,t}…]}  鑑定額の高い順（上位 KEEP 件）
//   POST /api/rank {n,p,r,k,u} → 中身を検証し、上位に入れば保存して {pos,id,list}（u はなまえ：ひらがな6文字まで）
//   POST /api/play {f}        → プレイ回数を1つ数える（f=1 ならその端末の初回＝新しい人）
//   GET  /stats               → プレイ回数・人数の集計（日本時間の日ごと）
//   POST /stats/reset {k}     → 合言葉が合えば集計を0に戻す（番付は消さない）。合言葉は Cloudflare の Secret「STATS_KEY」に登録する（コードには書かない）
// 保存先は Durable Object（SQLite、無料プランで使える）1つ。KV のような事前の作成や ID の設定は要らない
// 自由な文字は受け取らない。なまえはひらがな6文字まで、銘はゲームの語彙の組み合わせだけを通す
import {DurableObject} from 'cloudflare:workers';

const KEEP=20;
const GLAZE='曜変天目|油滴天目|青磁|瑠璃|辰砂|織部|志野|粉引|灰被|黄瀬戸';
const MID='高継|大ぶり|極薄手|括れ|朝顔形|窄口|胴張|平造|細口|鎬文|歪み';
const ATT='片口|輪花|耳付|手付';
const KIND='長頸壺|大鉢|茶碗|徳利|深鉢|壺|大甕|平皿|鶴首花入|段花入|沓茶碗|水注';
const NAME_RE=new RegExp('^(?:(?:'+GLAZE+')(?:'+MID+')(?:'+ATT+')?(?:'+KIND+')|(?:信楽|備前|伊賀)素焼(?:湯呑|置物))$');
const SING_NAME='前例なきため未定';
// 上限：通常は 1億×回転倍率41 ほど、特異点は圏内に居続けるほど青天井（実測 ¥143億）。あり得ない桁だけを弾く
const P_MAX=1e12,SING_MIN=850000000;
// 格付ごとの鑑定額の範囲（ゲームの appraise と同じ境目）
const RANKS={
  '人間国宝':[1e8,P_MAX],'重要文化財':[1e7,1e8-1],'名品':[1e6,1e7-1],'民芸品':[1e4,1e6-1],'等外':[1,1e4-1],
  '前衛の特異点':[SING_MIN,2e9-1],'神域の特異点':[2e9,5e9-1],'創世の特異点':[5e9,P_MAX],
};
const RANK_KEY={'人間国宝':'kokuho','重要文化財':'juyo','名品':'meihin','民芸品':'mingei','等外':'togai',
  '前衛の特異点':'zenei','神域の特異点':'shiniki','創世の特異点':'sousei'};
const KIND_KEYS=['tall','wide','thin','waist','flare','closed','bulge','flat','slender','ridge','twist','suichu'];

function json(o,status){return new Response(JSON.stringify(o),{status:status||200,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
// なまえ：ひらがなと「ー」で6文字まで（空なら名無し）。よくある悪口は弾く
const NAME_NG=['しね','しんで','ころす','ころせ','ちんこ','ちんぽ','まんこ','せっくす','れいぷ','きちがい','がいじ'];
function validUser(u){
  if(u===undefined||u==='')return '';
  if(typeof u!=='string'||!/^[ぁ-ゖー]{1,6}$/.test(u)||NAME_NG.some(w=>u.includes(w)))return null;
  return u;
}
function valid(b){
  if(!b||typeof b!=='object')return null;
  const n=b.n,p=b.p,r=b.r,k=b.k,u=validUser(b.u);
  if(u===null)return null;
  if(typeof n!=='string'||typeof r!=='string'||typeof k!=='string'||typeof p!=='number')return null;
  if(!Number.isInteger(p)||!RANKS[r])return null;
  const [lo,hi]=RANKS[r];if(p<lo||p>hi)return null;
  if(/特異点$/.test(r)){if(n!==SING_NAME||k!==RANK_KEY[r])return null;}
  else{
    if(!NAME_RE.test(n))return null;
    // 人間国宝の釉薬は曜変天目（素焼を除く）
    if(r==='人間国宝'&&!/^曜変天目|素焼/.test(n))return null;
    const m=/^([a-z]+)-([a-z]+)$/.exec(k);
    if(!m||!KIND_KEYS.includes(m[1])||m[2]!==RANK_KEY[r])return null;
    if((m[1]==='suichu')!==/水注$/.test(n))return null;
  }
  // ゲームは1万円以上を有効数字4桁に丸める
  if(p>=1e4){const e=Math.pow(10,Math.floor(Math.log10(p))-3);if(p%e!==0)return null;}
  return {n,p,r,k,u};
}
// 日本時間の日付 YYYY-MM-DD
const jstDay=t=>new Date(t+9*3600e3).toISOString().slice(0,10);

// 番付とプレイ数を持つ Durable Object（1つだけ使う）。中の処理は1件ずつ順番に動くので、同時に書いても壊れない
export class Board extends DurableObject{
  async top(){return (await this.ctx.storage.get('top'))||[];}
  async submit(v){
    const list=await this.top();
    const same=list.findIndex(e=>e.n===v.n&&e.p===v.p);
    if(same>=0)return {pos:same+1,id:list[same].id,list};
    if(list.length>=KEEP&&v.p<=list[list.length-1].p)return {pos:null,list};
    const e=Object.assign({id:crypto.randomUUID().slice(0,8),t:Date.now()},v);
    list.push(e);list.sort((a,b)=>b.p-a.p||a.t-b.t);list.length=Math.min(list.length,KEEP);
    await this.ctx.storage.put('top',list);
    const pos=list.findIndex(x=>x.id===e.id)+1;
    return {pos:pos||null,id:e.id,list};
  }
  async play(first){
    const d=jstDay(Date.now()),s=this.ctx.storage;
    const k=['plays','plays:'+d].concat(first?['players','players:'+d]:[]);
    const cur=await s.get(k),o={};
    for(const x of k)o[x]=(cur.get(x)||0)+1;
    await s.put(o);
  }
  async stats(days){
    const s=this.ctx.storage,now=Date.now(),ks=['plays','players'],rows=[];
    for(let i=0;i<days;i++){const d=jstDay(now-i*86400e3);rows.push(d);ks.push('plays:'+d,'players:'+d);}
    const m=await s.get(ks);
    return {plays:m.get('plays')||0,players:m.get('players')||0,
      days:rows.map(d=>({d,plays:m.get('plays:'+d)||0,players:m.get('players:'+d)||0}))};
  }
  // 集計（plays… と players… で始まる値）を全部消す。番付（top）は残す
  async resetStats(){
    const s=this.ctx.storage,ks=[];
    for(const p of ['plays','players'])ks.push(...(await s.list({prefix:p})).keys());
    for(let i=0;i<ks.length;i+=128)await s.delete(ks.slice(i,i+128));
    return ks.length;
  }
}
const board=env=>env.BOARD.get(env.BOARD.idFromName('main'));

// 同じ端末（IP）からの連投を止める（秒）
async function busy(req,tag,sec){
  const ip=req.headers.get('cf-connecting-ip')||'';if(!ip)return false;
  const rk=new Request('https://rate.local/'+tag+'/'+encodeURIComponent(ip)),c=caches.default;
  if(await c.match(rk))return true;
  await c.put(rk,new Response('1',{headers:{'cache-control':'max-age='+sec}}));
  return false;
}
async function rank(req,env){
  if(req.method==='GET')return json({list:await board(env).top()});
  if(req.method!=='POST')return json({error:'method'},405);
  if(await busy(req,'rank',10))return json({error:'busy'},429);
  let b;try{b=await req.json();}catch(e){return json({error:'bad'},400);}
  const v=valid(b);if(!v)return json({error:'invalid'},400);
  return json(await board(env).submit(v));
}
async function play(req,env){
  if(req.method!=='POST')return json({error:'method'},405);
  // 1回のプレイは10秒以上かかるので、それより短い間隔の連打は数えない
  if(await busy(req,'play',8))return json({ok:false},429);
  let b={};try{b=await req.json();}catch(e){}
  await board(env).play(b&&b.f===1);
  return json({ok:true});
}
// 合言葉の照合（長さや一致した文字数で時間が変わらないように比べる）
async function keyOk(given,env){
  const want=env.STATS_KEY;
  if(typeof want!=='string'||!want||typeof given!=='string')return false;
  const h=async t=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t)));
  const a=await h(given),b=await h(want);
  return crypto.subtle.timingSafeEqual(a,b);
}
async function statsReset(req,env){
  if(req.method!=='POST')return json({error:'method'},405);
  // 合言葉の総当たりを防ぐ：同じ端末からは5秒に1回まで
  const go=r=>Response.redirect(new URL('/stats?r='+r,req.url).toString(),303);
  if(await busy(req,'reset',5))return go('busy');
  let k='';try{k=String((await req.formData()).get('k')||'');}catch(e){}
  if(!env.STATS_KEY)return go('nokey');
  if(!(await keyOk(k,env)))return go('ng');
  await board(env).resetStats();
  return go('ok');
}
async function statsPage(req,env){
  const st=await board(env).stats(30);
  const r=new URL(req.url).searchParams.get('r');
  const MSG={ok:'集計を0に戻しました。',ng:'合言葉が違います。',busy:'少し待ってからもう一度押してください。',nokey:'合言葉（STATS_KEY）が Cloudflare に登録されていません。'};
  const msg=MSG[r]?`<p class="m${r==='ok'?'':' ng'}">${MSG[r]}</p>`:'';
  const tr=st.days.map(x=>`<tr><td>${x.d}</td><td>${x.plays.toLocaleString()}</td><td>${x.players.toLocaleString()}</td></tr>`).join('');
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>集計｜10秒暴走ろくろ</title>
<style>body{margin:0;padding:16px;background:#ebe5d9;color:#1b1814;font-family:"Hiragino Mincho ProN","Yu Mincho",serif}h1{font-size:20px;margin:0 0 12px}
.t{display:flex;gap:24px;margin-bottom:16px}.t b{display:block;font-size:28px}table{border-collapse:collapse;width:100%;max-width:480px;font-variant-numeric:tabular-nums}
td,th{border-bottom:1px solid rgba(27,24,20,.16);padding:6px 4px;text-align:right}td:first-child,th:first-child{text-align:left}small{color:#6e6458}
.m{margin:0 0 12px;color:#1b1814}.m.ng{color:#c8371a}
form{display:flex;gap:8px;margin-top:28px;max-width:480px}form input{flex:1;min-width:0;font:inherit;padding:8px;border:1px solid rgba(27,24,20,.3);background:#f6f1e7;border-radius:0}
form button{font:inherit;font-weight:700;padding:8px 14px;border:0;background:#1b1814;color:#f6f1e7;border-radius:0;cursor:pointer}</style></head><body>
<h1>10秒暴走ろくろ 集計</h1>${msg}
<div class="t"><div>プレイ回数<b>${st.plays.toLocaleString()}</b></div><div>プレイした人<b>${st.players.toLocaleString()}</b></div></div>
<table><tr><th>日付（日本時間）</th><th>回数</th><th>新しい人</th></tr>${tr}</table>
<p><small>人数は「その端末で初めて遊んだ回」を数えたもの。ブラウザの記録を消すと、同じ人でも新しい人として数え直されます。</small></p>
<form method="post" action="/stats/reset" onsubmit="return confirm('プレイ回数と人数を0に戻します（番付は消えません）。よろしいですか？')">
<input type="password" name="k" placeholder="合言葉" autocomplete="current-password" required><button>集計をリセット</button></form>
</body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
}
export default {
  async fetch(req,env){
    const p=new URL(req.url).pathname;
    if(p==='/api/rank')return rank(req,env);
    if(p==='/api/play')return play(req,env);
    if(p==='/stats')return statsPage(req,env);
    if(p==='/stats/reset')return statsReset(req,env);
    return env.ASSETS.fetch(req);
  }
};
