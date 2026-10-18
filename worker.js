// 10秒暴走ろくろ：番付（ランキング）とプレイ数の API。それ以外のパスは静的ファイル（index.html など）をそのまま返す
//   GET  /api/rank            → {list:[{id,n,p,r,k,t}…], kinds:{tall:[…],…}, low:[…], total}  総合・器種別（11種）・逆番付と、これまでの登録数
//   POST /api/rank {n,p,r,k,u,d} → 中身を検証し、総合か器種別の上位に入れば保存して {pos,kpos,kind,id,best,list,kinds,total}（u はなまえ：ひらがな6文字まで）
//                               d は端末番号。各番付に1端末1件（自己ベストだけ）。より良い記録なら入れ替えて best=true
//                               器種は銘の末尾（茶碗・大鉢…）から決める。素焼と古い特異点の銘は総合だけ
//                               逆番付（low：安い順の1本）にも入れてみる。崩壊（鑑定不能・産業廃棄物）は逆番付にだけ載る → {lpos,low}
//   POST /api/play {f,c,k}    → プレイ回数を1つ数える（f=1 ならその端末の初回＝新しい人、c=1 なら崩れずに完成した品として made も数える、
//                               k は完成品の器種で made:<器種> も数える）。made と器種別（madeKinds）は番付の見出しに出す。集計のリセットでは消さない
//   GET  /stats               → 合言葉の入力欄だけ
//   POST /stats {k,a,id}      → 合言葉が合えば、集計（日本時間の日ごと）と番付の全件を見せる。a=reset で集計を0に、a=del で番付の1件を消す
//                               合言葉は Cloudflare の Secret「STATS_KEY」に登録する（コードには書かない）
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
// 上限はゲームで出せる額に合わせる（うその高値で番付を占められないように）
//   通常：基準の上限 ¥1億 × 回転倍率41 × 揺らぎ 1.06 ≒ ¥43億 → ¥50億まで
//   特異点：圏内に居続けた時間で伸びる。10秒ずっと圏内・形も満点で計算上 ¥900億ほど → ¥1000億まで
const NORMAL_MAX=5e9,SING_MAX=1e11,SING_MIN=850000000;
// 格付ごとの鑑定額の範囲（ゲームの appraise・singRank と同じ境目）。特異点の上は大数の単位で段を切る
const RANKS={
  '人間国宝':[1e8,NORMAL_MAX],'重要文化財':[1e7,1e8-1],'名品':[1e6,1e7-1],'民芸品':[1e4,1e6-1],'等外':[1,1e4-1],
  '前衛の特異点':[SING_MIN,2e9-1],'神域の特異点':[2e9,5e9-1],'創世の特異点':[5e9,1e10-1],
  '恒河沙の特異点':[1e10,1.5e10-1],'阿僧祇の特異点':[1.5e10,2e10-1],'那由他の特異点':[2e10,3e10-1],
  '不可思議の特異点':[3e10,5e10-1],'無量大数の特異点':[5e10,SING_MAX],
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
// 失敗の中身は短い説明だけを返す（内部の呼び出し経路は見せない）
const errText=e=>String(e&&e.message||e).slice(0,120);
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
// 端末の見分け（1人1件のため）。ゲームが送る端末番号 d を、ここで鍵付きのハッシュにして dh として持つ。dh は外へ出さない
async function devHash(d){
  if(typeof d!=='string'||!/^[0-9a-f]{16,32}$/.test(d))return '';
  const h=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('rokuro-dev:'+d)));
  return [...h.slice(0,12)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
// 外へ返す番付から dh を外す
const pub=l=>l.map(({dh,...e})=>e);
const pubKinds=o=>Object.fromEntries(Object.entries(o).map(([k,l])=>[k,pub(l)]));
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
  // これまでに番付へ登録された品数。数え始める前の分は、今どこかの番付に残っている件数から始める
  async total(){
    const s=this.ctx.storage;let n=await s.get('regs');
    if(typeof n!=='number'){
      const ids=new Set();[await this.top(),await this.low(),...Object.values(await this.kinds())].forEach(l=>l.forEach(e=>ids.add(e.id)));
      n=ids.size;await s.put('regs',n);
    }
    return n;
  }
  // 総合・その器種の部・逆番付に入れてみる。どれかに入れば同じ id で保存する。崩壊は逆番付だけ
  // 1人1件：同じ端末（dh）の記録が既にあれば、それより良いときだけ入れ替える（総合・器種別は高い方、逆番付は安い方が良い）
  async submit(v){
    const s=this.ctx.storage,list=await this.top(),kinds=await this.kinds(),low=await this.low();let total=await this.total();
    const col=!!COLLAPSE[v.r],kind=col?'':nameKind(v.n),kl=kind?kinds[kind]:null;
    const posOf=(l,id)=>{const i=l?l.findIndex(x=>x.id===id):-1;return i>=0?i+1:null;};
    const res=(id,best)=>({pos:posOf(list,id),kpos:posOf(kl,id),lpos:posOf(low,id),best:!!best,kind,id,list:pub(list),kinds:pubKinds(kinds),low:pub(low),total});
    // 同じ記録の出し直し（総合・器種別で同じ銘と額があれば）は、載っている順位を返すだけ。逆番付は同じ額の崩壊が多いので比べない
    const same=!col&&(list.find(e=>e.n===v.n&&e.p===v.p)||(kl&&kl.find(e=>e.n===v.n&&e.p===v.p)));
    if(same)return res(same.id);
    // その番付に入るか。入るなら、入れ替える自分の古い記録の位置（無ければ -1）
    const plan=(l,dir,ok)=>{
      if(!l||!ok)return null;
      const i=v.dh?l.findIndex(e=>e.dh===v.dh):-1;
      if(i>=0)return (dir>0?v.p>l[i].p:v.p<l[i].p)?{i}:null;
      return (l.length<KEEP||(dir>0?v.p>l[l.length-1].p:v.p<l[l.length-1].p))?{i:-1}:null;
    };
    // 逆番付は ¥1万未満（等外と崩壊）だけ。件数が少ないうちに高値が紛れ込まないように
    const pA=plan(list,1,!col),pK=plan(kl,1,true),pL=plan(low,-1,v.p<LOW_MAX);
    if(!pA&&!pK&&!pL)return res(null);
    const e=Object.assign({id:crypto.randomUUID().slice(0,8),t:Date.now()},v);
    const add=(l,dir,pl)=>{if(pl.i>=0)l.splice(pl.i,1);l.push(e);l.sort((a,b)=>dir*(b.p-a.p)||a.t-b.t);l.length=Math.min(l.length,KEEP);};
    const w={regs:++total};
    if(pA){add(list,1,pA);w.top=list;}
    if(pK){add(kl,1,pK);w['top:'+kind]=kl;}
    if(pL){add(low,-1,pL);w.low=low;}
    await s.put(w);
    return res(e.id,[pA,pK,pL].some(p=>p&&p.i>=0));
  }
  // 番付の1件を、総合・器種別・逆番付のすべてから消す（集計ページから。登録数はそのまま）
  async remove(id){
    const s=this.ctx.storage,lists={top:await this.top(),low:await this.low()};
    for(const [k,l] of Object.entries(await this.kinds()))lists['top:'+k]=l;
    const w={};let hit=0;
    for(const [k,l] of Object.entries(lists)){const f=l.filter(e=>e.id!==id);if(f.length!==l.length){w[k]=f;hit++;}}
    if(hit)await s.put(w);
    return hit>0;
  }
  // これまでに完成した品数（崩れずに焼き上がった回。番付に載ったかは問わない）。数え始める前の分は、番付の登録数から始める
  async made(){
    const s=this.ctx.storage;let n=await s.get('made');
    if(typeof n!=='number'){n=await this.total();await s.put('made',n);}
    return n;
  }
  // 器種別の完成数 {tall:…,…}。数え始める前の分は、番付に残っているその器種の記録数から始める
  async madeKinds(){
    const s=this.ctx.storage,m=await s.get(KIND_PARTS.map(k=>'made:'+k)),o={};let ids=null;
    for(const k of KIND_PARTS){
      let n=m.get('made:'+k);
      if(typeof n!=='number'){
        if(!ids){ids=new Map();[await this.top(),...Object.values(await this.kinds())].forEach(l=>l.forEach(e=>ids.set(e.id,e.n)));}
        n=[...ids.values()].filter(nm=>nameKind(nm)===k).length;await s.put('made:'+k,n);
      }
      o[k]=n;
    }
    return o;
  }
  async play(first,done,kind){
    const d=jstDay(Date.now()),s=this.ctx.storage;
    const k=['plays','plays:'+d].concat(first?['players','players:'+d]:[]);
    const cur=await s.get(k),o={};
    for(const x of k)o[x]=(cur.get(x)||0)+1;
    if(done){
      o.made=(await this.made())+1;
      if(KIND_PARTS.includes(kind))o['made:'+kind]=(await this.madeKinds())[kind]+1;
    }
    await s.put(o);
  }
  async stats(days){
    const s=this.ctx.storage,now=Date.now(),ks=['plays','players'],rows=[];
    for(let i=0;i<days;i++){const d=jstDay(now-i*86400e3);rows.push(d);ks.push('plays:'+d,'players:'+d);}
    const m=await s.get(ks);
    return {plays:m.get('plays')||0,players:m.get('players')||0,
      days:rows.map(d=>({d,plays:m.get('plays:'+d)||0,players:m.get('players:'+d)||0}))};
  }
  // 集計（plays… と players… で始まる値）を全部消す。番付は残す
  async resetStats(){
    const s=this.ctx.storage,ks=[];
    for(const p of ['plays','players'])ks.push(...(await s.list({prefix:p})).keys());
    for(let i=0;i<ks.length;i+=128)await s.delete(ks.slice(i,i+128));
    return ks.length;
  }
}
const board=env=>env.BOARD.get(env.BOARD.idFromName('main'));

// 同じ端末（IP）からの連投を止める（秒）。mark だけ・has だけも使えるように分けてある
const rateKey=(req,tag)=>new Request('https://rate.local/'+tag+'/'+encodeURIComponent(req.headers.get('cf-connecting-ip')||''));
const hasIp=req=>!!req.headers.get('cf-connecting-ip');
async function rateHas(req,tag){return hasIp(req)&&!!(await caches.default.match(rateKey(req,tag)));}
async function rateMark(req,tag,sec){if(hasIp(req))await caches.default.put(rateKey(req,tag),new Response('1',{headers:{'cache-control':'max-age='+sec}}));}
async function busy(req,tag,sec){if(await rateHas(req,tag))return true;await rateMark(req,tag,sec);return false;}

async function rank(req,env){
  // 総合はいつでも返す。器種別・逆番付・登録数で失敗しても総合は見られるようにし、失敗は err に短く入れる
  if(req.method==='GET'){
    const b=board(env),o={list:pub(await b.top())},err=[];
    try{o.kinds=pubKinds(await b.kinds());}catch(e){err.push('kinds: '+errText(e));}
    try{o.low=pub(await b.low());}catch(e){err.push('low: '+errText(e));}
    try{o.total=await b.total();o.made=await b.made();o.madeKinds=await b.madeKinds();}catch(e){err.push('total: '+errText(e));}
    if(err.length)o.err=err;
    return json(o);
  }
  if(req.method!=='POST')return json({error:'method'},405);
  if(await busy(req,'rank',10))return json({error:'busy'},429);
  let b;try{b=await req.json();}catch(e){return json({error:'bad'},400);}
  const v=valid(b);if(!v)return json({error:'invalid'},400);
  const dh=await devHash(b.d);if(dh)v.dh=dh;
  try{return json(await board(env).submit(v));}catch(e){return json({error:'server',err:errText(e)},500);}
}
async function play(req,env){
  if(req.method!=='POST')return json({error:'method'},405);
  // 1回のプレイは10秒以上かかるので、それより短い間隔の連打は数えない
  if(await busy(req,'play',8))return json({ok:false},429);
  let b={};try{b=await req.json();}catch(e){}
  await board(env).play(b&&b.f===1,b&&b.c===1,b&&typeof b.k==='string'?b.k:'');
  return json({ok:true});
}

// ---- 集計ページ（合言葉が要る） ----
// 合言葉の照合（長さや一致した文字数で時間が変わらないように比べる）
async function keyOk(given,env){
  const want=env.STATS_KEY;
  if(typeof want!=='string'||!want||typeof given!=='string')return false;
  const h=async t=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t)));
  const a=await h(given),b=await h(want);
  return crypto.subtle.timingSafeEqual(a,b);
}
const esc=t=>String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen=p=>'¥'+Number(p).toLocaleString('ja-JP');
const CSS=`body{margin:0;padding:16px;background:#ebe5d9;color:#1b1814;font-family:"Hiragino Mincho ProN","Yu Mincho",serif}h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:28px 0 8px}
.t{display:flex;gap:24px;margin-bottom:16px}.t b{display:block;font-size:28px}table{border-collapse:collapse;width:100%;max-width:640px;font-variant-numeric:tabular-nums}
td,th{border-bottom:1px solid rgba(27,24,20,.16);padding:6px 4px;text-align:right;vertical-align:middle}td:first-child,th:first-child{text-align:left}small{color:#6e6458}
.m{margin:0 0 12px;color:#1b1814}.m.ng{color:#c8371a}td.l{text-align:left}td small{display:block}
form{display:flex;gap:8px;max-width:480px;margin:0}form.k{margin-top:8px}form input{flex:1;min-width:0;font:inherit;padding:8px;border:1px solid rgba(27,24,20,.3);background:#f6f1e7;border-radius:0}
button{font:inherit;font-weight:700;padding:8px 14px;border:0;background:#1b1814;color:#f6f1e7;border-radius:0;cursor:pointer}td button{padding:4px 10px;font-size:13px;background:#a12b12}`;
const page=(body)=>new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>集計｜10秒暴走ろくろ</title><style>${CSS}</style></head><body>
<h1>10秒暴走ろくろ 集計</h1>${body}</body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer'}});
const MSG={ok:'集計を0に戻しました。',del:'番付から1件消しました。',gone:'その記録はもう番付にありません。',ng:'合言葉が違います。',busy:'少し待ってからもう一度入れてください。',switch:'更新の切り替え中です。1〜2分たってから、もう一度開いてください。',nokey:'合言葉（STATS_KEY）が Cloudflare に登録されていません。'};
const msgHtml=r=>MSG[r]?`<p class="m${['ok','del'].includes(r)?'':' ng'}">${MSG[r]}</p>`:'';
const loginPage=r=>page(`${msgHtml(r)}<form method="post" action="/stats"><input type="password" name="k" placeholder="合言葉" autocomplete="current-password" required autofocus><input type="hidden" name="a" value="view"><button>開く</button></form>`);

async function stats(req,env){
  if(req.method==='GET')return loginPage('');
  if(req.method!=='POST')return json({error:'method'},405);
  let f=null;try{f=await req.formData();}catch(e){}
  const k=String(f&&f.get('k')||''),a=String(f&&f.get('a')||'view'),id=String(f&&f.get('id')||'');
  if(!env.STATS_KEY)return loginPage('nokey');
  // 合言葉の総当たりを防ぐ：間違えたら、同じ端末からは5秒待たないと次を試せない（合っている人の操作は止めない）
  if(await rateHas(req,'statsng'))return loginPage('busy');
  if(!(await keyOk(k,env))){await rateMark(req,'statsng',5);return loginPage('ng');}
  // 公開し直した直後の数分は、保存先（Durable Object）だけ古い版のまま動くことがある。そのときは止まらずに知らせる
  try{return await statsBody(env,k,a,id);}catch(e){return loginPage('switch');}
}
async function statsBody(env,k,a,id){
  const b=board(env);let r='';
  if(a==='reset'){await b.resetStats();r='ok';}
  else if(a==='del'&&/^[0-9a-f]{8}$/.test(id))r=(await b.remove(id))?'del':'gone';
  const st=await b.stats(30),top=await b.top(),low=await b.low(),kinds=await b.kinds(),total=await b.total(),made=await b.made(),mk=await b.madeKinds();
  // 番付は総合・器種別・逆番付をまとめて1件ずつ並べ、どこに載っているかを添える
  const seen=new Map();
  const put=(l,tag)=>l.forEach(e=>{const x=seen.get(e.id)||{e,tags:[]};x.tags.push(tag);seen.set(e.id,x);});
  put(top,'総合');put(low,'逆番付');for(const [kk,l] of Object.entries(kinds))put(l,KIND_WORD[kk]+'の部');
  const rows=[...seen.values()].sort((x,y)=>y.e.p-x.e.p);
  const hk=`<input type="hidden" name="k" value="${esc(k)}">`;
  const tr=st.days.map(x=>`<tr><td>${x.d}</td><td>${x.plays.toLocaleString()}</td><td>${x.players.toLocaleString()}</td></tr>`).join('');
  const rk=rows.map(({e,tags})=>{const d=new Date(e.t+9*3600e3);return `<tr><td class="l">${esc(e.u||'名無し')}<small>「${esc(e.n)}」${esc(e.r)}　${d.getUTCMonth()+1}/${d.getUTCDate()}　${esc(tags.join('・'))}</small></td><td>${yen(e.p)}</td>
<td><form method="post" action="/stats" onsubmit="return confirm('この記録を番付から消します。よろしいですか？')">${hk}<input type="hidden" name="a" value="del"><input type="hidden" name="id" value="${esc(e.id)}"><button>消す</button></form></td></tr>`;}).join('');
  return page(`${msgHtml(r)}
<div class="t"><div>プレイ回数<b>${st.plays.toLocaleString()}</b></div><div>プレイした人<b>${st.players.toLocaleString()}</b></div><div>完成した品<b>${made.toLocaleString()}</b></div><div>番付の登録<b>${total.toLocaleString()}</b></div></div>
<p><small>器種別の完成：${KIND_PARTS.map(kk=>KIND_WORD[kk]+' '+mk[kk].toLocaleString()).join('　')}</small></p>
<table><tr><th>日付（日本時間）</th><th>回数</th><th>新しい人</th></tr>${tr}</table>
<p><small>人数は「その端末で初めて遊んだ回」を数えたもの。ブラウザの記録を消すと、同じ人でも新しい人として数え直されます。</small></p>
<form class="k" method="post" action="/stats" onsubmit="return confirm('プレイ回数と人数を0に戻します（番付は消えません）。よろしいですか？')">${hk}<input type="hidden" name="a" value="reset"><button>集計をリセット</button></form>
<h2>番付の記録（${rows.length}件）</h2>
<table>${rk||'<tr><td>まだ記録がありません</td></tr>'}</table>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="view"><button>最新にする</button></form>`);
}
export default {
  async fetch(req,env){
    const p=new URL(req.url).pathname;
    if(p==='/api/rank')return rank(req,env);
    if(p==='/api/play')return play(req,env);
    if(p==='/stats')return stats(req,env);
    return env.ASSETS.fetch(req);
  }
};
