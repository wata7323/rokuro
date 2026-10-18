// 10秒暴走ろくろ：番付（ランキング）とプレイ数の API。それ以外のパスは静的ファイル（index.html など）をそのまま返す
//   GET  /api/rank            → {list:[{id,n,p,r,k,t}…], kinds:{tall:[…],…}}  総合と器種別（11種）の番付。鑑定額の高い順
//   POST /api/rank {n,p,r,k,u} → 中身を検証し、総合か器種別の上位に入れば保存して {pos,kpos,kind,id,list,kinds}（u はなまえ：ひらがな6文字まで）
//                               器種は銘の末尾（茶碗・大鉢…）から決める。素焼と古い特異点の銘は総合だけ
//                               逆番付（low：安い順の1本）にも入れてみる。崩壊（鑑定不能・産業廃棄物）は逆番付にだけ載る → {lpos,low}
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
// 特異点の銘：「円相・器の名前」（虹彩の釉なので釉の語なし）。古い版の「前例なきため未定」も、端末に残った古いページのために通す
const SING_RE=new RegExp('^円相・(?:(?:'+MID+')(?:'+ATT+')?(?:'+KIND+')|(?:信楽|備前|伊賀)素焼(?:湯呑|置物))$');
const SING_OLD='前例なきため未定';
// 上限：通常は 1億×回転倍率41 ほど、特異点は圏内に居続けるほど青天井（実測 ¥143億、計算上 ¥1000億ほど）。あり得ない桁だけを弾く
const P_MAX=1e15,SING_MIN=850000000;
// 格付ごとの鑑定額の範囲（ゲームの appraise・singRank と同じ境目）。特異点の上は大数の単位で段を切る
const RANKS={
  '人間国宝':[1e8,P_MAX],'重要文化財':[1e7,1e8-1],'名品':[1e6,1e7-1],'民芸品':[1e4,1e6-1],'等外':[1,1e4-1],
  '前衛の特異点':[SING_MIN,2e9-1],'神域の特異点':[2e9,5e9-1],'創世の特異点':[5e9,1e10-1],
  '恒河沙の特異点':[1e10,1.5e10-1],'阿僧祇の特異点':[1.5e10,2e10-1],'那由他の特異点':[2e10,3e10-1],
  '不可思議の特異点':[3e10,5e10-1],'無量大数の特異点':[5e10,P_MAX],
  // 崩壊：破片の値段（ふつう ¥2〜数百、高値で崩れても数千円まで）。逆番付にだけ載る
  '鑑定不能':[1,1e4-1],'産業廃棄物':[1,1e4-1],
};
const LOW_MAX=1e4;   // 逆番付に載るのは この額未満
const COLLAPSE={'鑑定不能':['器体破片（飛散）','funo'],'産業廃棄物':['未成形土塊','haiki']};
const RANK_KEY={'人間国宝':'kokuho','重要文化財':'juyo','名品':'meihin','民芸品':'mingei','等外':'togai',
  '前衛の特異点':'zenei','神域の特異点':'shiniki','創世の特異点':'sousei',
  '恒河沙の特異点':'gogasha','阿僧祇の特異点':'asogi','那由他の特異点':'nayuta','不可思議の特異点':'fukashigi','無量大数の特異点':'muryo'};
const KIND_KEYS=['tall','wide','thin','waist','flare','closed','bulge','flat','slender','ridge','twist','suichu'];
// 器種別の番付の部（図鑑と同じ11種）。水注は胴張りの器に注ぎ口が付いたものなので大甕の部
const KIND_WORD={tall:'長頸壺',wide:'大鉢',thin:'茶碗',waist:'徳利',flare:'深鉢',closed:'壺',bulge:'大甕',flat:'平皿',slender:'鶴首花入',ridge:'段花入',twist:'沓茶碗'};
const KIND_PARTS=Object.keys(KIND_WORD);
const KIND_ENDS=Object.entries(KIND_WORD).concat([['bulge','水注']]).sort((a,b)=>b[1].length-a[1].length);
function nameKind(n){if(/素焼/.test(n))return '';const w=KIND_ENDS.find(([,w])=>n.endsWith(w));return w?w[0]:'';}

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
  if(COLLAPSE[r]){if(n!==COLLAPSE[r][0]||k!==COLLAPSE[r][1])return null;}
  else if(/特異点$/.test(r)){if(!(SING_RE.test(n)||n===SING_OLD)||k!==RANK_KEY[r])return null;}
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
  async low(){return (await this.ctx.storage.get('low'))||[];}
  // 器種別の番付。まだ無ければ、総合に載っている記録から作る（器種別を足す前の記録も入るように）
  async kinds(){
    const s=this.ctx.storage,m=await s.get(KIND_PARTS.map(k=>'top:'+k));
    let all=null;const o={};
    for(const k of KIND_PARTS){
      let l=m.get('top:'+k);
      if(!l){all=all||await this.top();l=all.filter(e=>nameKind(e.n)===k).slice(0,KEEP);await s.put('top:'+k,l);}
      o[k]=l;
    }
    return o;
  }
  // 総合・その器種の部・逆番付に入れてみる。どれかに入れば同じ id で保存する。崩壊は逆番付だけ
  async submit(v){
    const s=this.ctx.storage,list=await this.top(),kinds=await this.kinds(),low=await this.low();
    const col=!!COLLAPSE[v.r],kind=col?'':nameKind(v.n),kl=kind?kinds[kind]:null;
    const posOf=(l,id)=>{const i=l?l.findIndex(x=>x.id===id):-1;return i>=0?i+1:null;};
    const res=id=>({pos:posOf(list,id),kpos:posOf(kl,id),lpos:posOf(low,id),kind,id,list,kinds,low});
    // 同じ記録の出し直し（総合・器種別で同じ銘と額があれば）は、載っている順位を返すだけ。逆番付は同じ額の崩壊が多いので比べない
    const same=!col&&(list.find(e=>e.n===v.n&&e.p===v.p)||(kl&&kl.find(e=>e.n===v.n&&e.p===v.p)));
    if(same)return res(same.id);
    const fitsHi=l=>!(l.length>=KEEP&&v.p<=l[l.length-1].p);
    // 逆番付は ¥1万未満（等外と崩壊）だけ。件数が少ないうちに高値が紛れ込まないように
    const fitsLo=l=>v.p<LOW_MAX&&!(l.length>=KEEP&&v.p>=l[l.length-1].p);
    const inAll=!col&&fitsHi(list),inKind=!!kl&&fitsHi(kl),inLow=fitsLo(low);
    if(!inAll&&!inKind&&!inLow)return res(null);
    const e=Object.assign({id:crypto.randomUUID().slice(0,8),t:Date.now()},v);
    const add=(l,dir)=>{l.push(e);l.sort((a,b)=>dir*(b.p-a.p)||a.t-b.t);l.length=Math.min(l.length,KEEP);};
    const w={};
    if(inAll){add(list,1);w.top=list;}
    if(inKind){add(kl,1);w['top:'+kind]=kl;}
    if(inLow){add(low,-1);w.low=low;}
    await s.put(w);
    return res(e.id);
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
  if(req.method==='GET'){const b=board(env);return json({list:await b.top(),kinds:await b.kinds(),low:await b.low()});}
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
