// 10秒暴走ろくろ：番付（ランキング）とプレイ数の API。それ以外のパスは静的ファイル（index.html など）をそのまま返す
//   GET  /api/rank            → {list:[{id,n,p,r,k,t}…], kinds:{tall:[…],…}, low:[…], total}  総合・器種別（11種）・逆番付と、これまでの登録数
//   POST /api/rank {n,p,r,k,u,d} → 中身を検証し、総合か器種別の上位に入れば保存して {pos,kpos,kind,id,best,list,kinds,total}（u はなまえ：ひらがな6文字まで）
//                               d は端末番号。各番付に1端末1件（自己ベストだけ）。より良い記録なら入れ替えて best=true
//                               器種は銘の末尾（茶碗・大鉢…）から決める。素焼と古い特異点の銘は総合だけ
//                               逆番付（low：安い順の1本）にも入れてみる。崩壊（鑑定不能・産業廃棄物）は逆番付にだけ載る → {lpos,low}
//   POST /api/play {f,c,k,e,v,l} → プレイ回数を1つ数える（f=1 ならその端末の初回＝新しい人、c=1 なら崩れずに完成した品として made も数える、
//                               k は完成品の器種で made:<器種> も数える）。made と器種別（madeKinds）は番付の見出しに出す。集計のリセットでは消さない
//                               e はプレイごとの番号（同じ e の送り直しは数えない）。v は版、l は調整用の記録（形・額・崩壊など）で plays_log に1行残す
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

// ---- 調整用のプレイ記録（1プレイ1行。名前・端末番号・IP は残さない） ----
const LOG_KEEP=200000;   // 新しい20万件だけ残す
const LOG_COLS=['eid','t','ver','first','res','reason','ctime','k1','v1','k2','v2','k3','v3','score','q','price','peak','rank','glaze','rpm','zone','pre'];
const SHAPES=['tall','wide','thin','waist','flare','closed','bulge','flat','slender','ridge','twist'];
const REASONS=['首折れ','遠心力で飛散','高さの限界','軸ブレ崩壊'];
const GLAZES=['yohen','yuteki','seiji','ruri','shinsha','oribe','shino','kohiki','tsuchi','kiseto','koge','sing'];
// ゲームから届いた記録を、決まった語と範囲の数だけに整える（自由な文字は残さない）
function cleanLog(L,ver){
  if(!L||typeof L!=='object')return null;
  const num=(x,lo,hi,d)=>typeof x==='number'&&isFinite(x)?+Math.min(hi,Math.max(lo,x)).toFixed(d):null;
  const pick=(x,list)=>list.includes(x)?x:null;
  const top=Array.isArray(L.top)?L.top.slice(0,3):[];
  const k=i=>(top[i]&&pick(top[i][0],SHAPES))||null,v=i=>k(i)?num(top[i][1],-9,9,3):null;
  return {ver:typeof ver==='string'&&/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ver)?ver:null,
    res:pick(L.res,['n','s','c']),reason:pick(L.reason,REASONS),ctime:num(L.ctime,0,15,2),
    k1:k(0),v1:v(0),k2:k(1),v2:v(1),k3:k(2),v3:v(2),score:num(L.score,0,1,3),q:num(L.q,0,1,3),
    price:num(L.price,0,1e12,0),peak:num(L.peak,0,1e12,0),rank:typeof L.rank==='string'&&(RANKS[L.rank]||L.rank==='泥塊')?L.rank:null,
    glaze:pick(L.glaze,GLAZES),rpm:num(L.rpm,0,100000,0),zone:num(L.zone,0,15,2),pre:pick(L.pre,SHAPES)};
}

// 番付とプレイ数を持つ Durable Object（1つだけ使う）。中の処理は1件ずつ順番に動くので、同時に書いても壊れない
export class Board extends DurableObject{
  constructor(ctx,env){
    super(ctx,env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS plays_log(eid TEXT PRIMARY KEY,t INTEGER,ver TEXT,first INTEGER,res TEXT,reason TEXT,ctime REAL,
      k1 TEXT,v1 REAL,k2 TEXT,v2 REAL,k3 TEXT,v3 REAL,score REAL,q REAL,price INTEGER,peak INTEGER,rank TEXT,glaze TEXT,rpm INTEGER,zone REAL,pre TEXT)`);
  }
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
      // 同じ端末の記録。無ければ、端末番号のない古い記録（ver. 1.3.0 より前）で同じなまえのものを同じ人とみなす
      let i=v.dh?l.findIndex(e=>e.dh===v.dh):-1;
      if(i<0&&v.u)i=l.findIndex(e=>!e.dh&&e.u===v.u);
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
  // 同じなまえの重複を整理する（1人1件を入れる前の記録の後始末）。各番付で、なまえごとに一番良い1件だけ残す
  // 名無しは別の人の集まりなので対象外。go=false なら消さずに、消す予定の一覧だけ返す
  async dedupeByName(go){
    const s=this.ctx.storage,lists=[['top','総合',await this.top(),1],['low','逆番付',await this.low(),-1]];
    for(const [k,l] of Object.entries(await this.kinds()))lists.push(['top:'+k,KIND_WORD[k]+'の部',l,1]);
    const out=[],w={};
    for(const [key,label,l,dir] of lists){
      const best={};
      for(const e of l){if(!e.u)continue;const b=best[e.u];if(!b||(dir>0?e.p>b.p:e.p<b.p)||(e.p===b.p&&e.t<b.t))best[e.u]=e;}
      const rm=l.filter(e=>e.u&&best[e.u].id!==e.id);
      if(!rm.length)continue;
      for(const e of rm)out.push({label,u:e.u,n:e.n,p:e.p,kn:best[e.u].n,kp:best[e.u].p});
      w[key]=l.filter(e=>!rm.includes(e));
    }
    if(go&&out.length)await s.put(w);
    return out;
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
  // 1プレイを数える。eid（プレイごとの番号）があれば記録を1行残し、同じ eid の送り直しは数えない（二重に数えない）
  async play(first,done,kind,eid,log){
    const d=jstDay(Date.now()),s=this.ctx.storage;
    if(eid){
      const L=log||{},row=[eid,Date.now(),L.ver,first?1:0,L.res,L.reason,L.ctime,L.k1,L.v1,L.k2,L.v2,L.k3,L.v3,L.score,L.q,L.price,L.peak,L.rank,L.glaze,L.rpm,L.zone,L.pre].map(x=>x===undefined?null:x);
      const c=s.sql.exec(`INSERT OR IGNORE INTO plays_log(${LOG_COLS.join(',')}) VALUES(${LOG_COLS.map(()=>'?').join(',')})`,...row);
      c.toArray();if(!c.rowsWritten)return {ok:true,dup:true};
    }
    const k=['plays','plays:'+d].concat(first?['players','players:'+d]:[]);
    const cur=await s.get(k),o={};
    for(const x of k)o[x]=(cur.get(x)||0)+1;
    if(done){
      o.made=(await this.made())+1;
      if(KIND_PARTS.includes(kind))o['made:'+kind]=(await this.madeKinds())[kind]+1;
    }
    await s.put(o);
    // 記録が増えすぎないように、500回に1回、古い分を消す
    if(eid&&o.plays%500===0)s.sql.exec(`DELETE FROM plays_log WHERE rowid<=(SELECT MAX(rowid) FROM plays_log)-?`,LOG_KEEP);
    return {ok:true};
  }
  // 調整用の分析（直近2万件。ver を渡すとその版だけ）。読み出しは1回あたり最大2万行
  analyze(ver){
    const all=this.ctx.storage.sql.exec(`SELECT ver,res,reason,k1,score,price,rank,pre,zone FROM plays_log ORDER BY rowid DESC LIMIT 20000`).toArray();
    const vc={};for(const r of all){const v=r.ver||'?';vc[v]=(vc[v]||0)+1;}
    const rows=ver?all.filter(r=>(r.ver||'?')===ver):all;
    const done=rows.filter(r=>r.res==='n'||r.res==='s'),col=rows.filter(r=>r.res==='c');
    const hi=r=>r.res==='s'||r.rank==='人間国宝';
    const q=(a,p)=>a.length?a[Math.min(a.length-1,Math.floor(a.length*p))]:0;
    const kinds=SHAPES.map(k=>{
      const d=done.filter(r=>r.k1===k),c=col.filter(r=>r.pre===k),ps=d.map(r=>r.price||0).sort((x,y)=>x-y);
      const why={};for(const r of c)if(r.reason)why[r.reason]=(why[r.reason]||0)+1;
      return {k,done:d.length,col:c.length,med:q(ps,0.5),p90:q(ps,0.9),max:ps.length?ps[ps.length-1]:0,
        hi:d.filter(hi).length,sing:d.filter(r=>r.res==='s').length,neat:d.filter(r=>(r.score||0)>=0.45).length,why};
    });
    const whyAll={};for(const r of col)if(r.reason)whyAll[r.reason]=(whyAll[r.reason]||0)+1;
    return {vers:Object.entries(vc).sort((a,b)=>b[0].localeCompare(a[0],undefined,{numeric:true})),n:rows.length,done:done.length,col:col.length,
      sing:done.filter(r=>r.res==='s').length,hi:done.filter(hi).length,whyAll,kinds};
  }
  // CSV（新しい順に最大5万件。それ以上は古い分を省く）
  csv(){
    const rows=this.ctx.storage.sql.exec(`SELECT ${LOG_COLS.slice(1).join(',')} FROM plays_log ORDER BY rowid DESC LIMIT 50000`).toArray();
    const cell=x=>x===null||x===undefined?'':(typeof x==='string'&&/[",\n]/.test(x)?'"'+x.replace(/"/g,'""')+'"':String(x));
    const head=LOG_COLS.slice(1);
    return [head.join(',')].concat(rows.map(r=>head.map(h=>h==='t'?cell(new Date(r.t+9*3600e3).toISOString().slice(0,19).replace('T',' ')):cell(r[h])).join(','))).join('\r\n');
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
  b=b&&typeof b==='object'?b:{};
  // e はプレイごとの番号（送り直しで二重に数えないため）、l は調整用の記録、v はゲームの版
  const eid=typeof b.e==='string'&&/^[0-9a-f]{16,32}$/.test(b.e)?b.e:'';
  try{return json(await board(env).play(b.f===1,b.c===1,typeof b.k==='string'?b.k:'',eid,eid?cleanLog(b.l,b.v):null));}
  catch(e){return json({error:'server',err:errText(e)},500);}
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
// デバッグの札：合言葉から作る（合言葉を変えると、それまでの札は使えなくなる）。集計ページを開いた端末に置き、ゲームが /api/dbg で確かめる
async function dbgToken(env){
  if(typeof env.STATS_KEY!=='string'||!env.STATS_KEY)return '';
  const h=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('rokuro-dbg:'+env.STATS_KEY)));
  return [...h.slice(0,16)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function dbgCheck(req,env){
  if(req.method!=='POST')return json({error:'method'},405);
  // 札の総当たりを防ぐ：外れたら、同じ端末からは5秒待たないと次を試せない
  if(await rateHas(req,'dbgng'))return json({ok:false},429);
  let b={};try{b=await req.json();}catch(e){}
  const want=await dbgToken(env),t=b&&typeof b.t==='string'?b.t:'';
  const ok=!!want&&t.length===want.length&&crypto.subtle.timingSafeEqual(new TextEncoder().encode(t),new TextEncoder().encode(want));
  if(!ok)await rateMark(req,'dbgng',5);
  return json({ok});
}
const esc=t=>String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen=p=>'¥'+Number(p).toLocaleString('ja-JP');
const CSS=`body{margin:0;padding:16px;background:#ebe5d9;color:#1b1814;font-family:"Hiragino Mincho ProN","Yu Mincho",serif}h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:28px 0 8px}
.t{display:flex;gap:24px;margin-bottom:16px}.t b{display:block;font-size:28px}table{border-collapse:collapse;width:100%;max-width:640px;font-variant-numeric:tabular-nums}
td,th{border-bottom:1px solid rgba(27,24,20,.16);padding:6px 4px;text-align:right;vertical-align:middle}td:first-child,th:first-child{text-align:left}small{color:#6e6458}
.m{margin:0 0 12px;color:#1b1814}.m.ng{color:#c8371a}td.l{text-align:left}td small{display:block}
form{display:flex;gap:8px;max-width:480px;margin:0}form.k{margin-top:8px}form input{flex:1;min-width:0;font:inherit;padding:8px;border:1px solid rgba(27,24,20,.3);background:#f6f1e7;border-radius:0}
button{font:inherit;font-weight:700;padding:8px 14px;border:0;background:#1b1814;color:#f6f1e7;border-radius:0;cursor:pointer}td button{padding:4px 10px;font-size:13px;background:#a12b12}
table.an th,table.an td{white-space:nowrap;font-size:12px;padding:5px 5px}`;
const page=(body)=>new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>集計｜10秒暴走ろくろ</title><style>${CSS}</style></head><body>
<h1>10秒暴走ろくろ 集計</h1>${body}</body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer'}});
const MSG={ok:'集計を0に戻しました。',del:'番付から1件消しました。',gone:'その記録はもう番付にありません。',ng:'合言葉が違います。',busy:'少し待ってからもう一度入れてください。',switch:'更新の切り替え中です。1〜2分たってから、もう一度開いてください。',nokey:'合言葉（STATS_KEY）が Cloudflare に登録されていません。'};
MSG.nodup='整理する重複はありませんでした。';
const msgHtml=r=>{
  const m=/^dedup:(\d+)$/.exec(r||'');if(m)return `<p class="m">${m[1]}件の重複を整理しました。</p>`;
  return MSG[r]?`<p class="m${['ok','del','nodup'].includes(r)?'':' ng'}">${MSG[r]}</p>`:'';
};
const loginPage=r=>page(`${msgHtml(r)}<form method="post" action="/stats"><input type="password" name="k" placeholder="合言葉" autocomplete="current-password" required autofocus><input type="hidden" name="a" value="view"><button>開く</button></form>`);

async function stats(req,env){
  if(req.method==='GET')return loginPage('');
  if(req.method!=='POST')return json({error:'method'},405);
  let f=null;try{f=await req.formData();}catch(e){}
  const k=String(f&&f.get('k')||''),a=String(f&&f.get('a')||'view'),id=String(f&&f.get('id')||'');
  const ver=/^(\d{1,3}\.\d{1,3}\.\d{1,3}|\?)$/.test(String(f&&f.get('ver')||''))?String(f.get('ver')):'';
  if(!env.STATS_KEY)return loginPage('nokey');
  // 合言葉の総当たりを防ぐ：間違えたら、同じ端末からは5秒待たないと次を試せない（合っている人の操作は止めない）
  if(await rateHas(req,'statsng'))return loginPage('busy');
  if(!(await keyOk(k,env))){await rateMark(req,'statsng',5);return loginPage('ng');}
  // 公開し直した直後の数分は、保存先（Durable Object）だけ古い版のまま動くことがある。そのときは止まらずに知らせる
  if(a==='csv'){
    try{return new Response('﻿'+await board(env).csv(),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="rokuro_plays.csv"','cache-control':'no-store'}});}
    catch(e){return loginPage('switch');}
  }
  try{return await statsBody(env,k,a,id,ver,await dbgToken(env));}catch(e){return loginPage('switch');}
}
// 額を短く（1.2億・340万・980）
const short=p=>p>=1e8?(p/1e8).toFixed(p>=1e9?0:1)+'億':(p>=1e4?Math.round(p/1e4).toLocaleString()+'万':String(Math.round(p)));
const pct=(a,b)=>b?Math.round(a/b*100)+'%':'-';
// 分析の欄：器種別の完成と額、作ろうとして崩れた割合
function analysisHtml(A,ver,hk){
  const opt=['<option value="">すべての版</option>'].concat(A.vers.map(([v,c])=>`<option value="${esc(v)}"${v===ver?' selected':''}>ver. ${esc(v)}（${c}回）</option>`)).join('');
  const kt=A.kinds.map(x=>`<tr><td>${KIND_WORD[x.k]}</td><td>${x.done}</td><td>${short(x.med)}</td><td>${short(x.p90)}</td><td>${short(x.max)}</td><td>${pct(x.hi,x.done)}</td><td>${pct(x.sing,x.done)}</td><td>${pct(x.neat,x.done)}</td></tr>`).join('');
  const ct=A.kinds.map(x=>{const t=x.done+x.col;const w=Object.entries(x.why).sort((a,b)=>b[1]-a[1]).map(([r,n])=>r+' '+n).join('・');
    return `<tr><td>${KIND_WORD[x.k]}</td><td>${t}</td><td>${x.col}</td><td>${pct(x.col,t)}</td><td class="l"><small>${esc(w)}</small></td></tr>`;}).join('');
  const wa=Object.entries(A.whyAll).sort((a,b)=>b[1]-a[1]).map(([r,n])=>r+' '+n).join('・');
  return `<h2>分析（直近${A.n.toLocaleString()}回）</h2>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="view"><select name="ver" style="flex:1;font:inherit;padding:8px;background:#f6f1e7;border:1px solid rgba(27,24,20,.3);border-radius:0">${opt}</select><button>絞り込む</button></form>
<p><small>完成 ${A.done}（特異点 ${A.sing}・人間国宝以上 ${A.hi}）／崩壊 ${A.col}（${pct(A.col,A.n)}）${wa?'：'+esc(wa):''}</small></p>
<h3 style="font-size:14px;margin:16px 0 4px">器種別の完成</h3>
<div style="overflow-x:auto"><table class="an"><tr><th>器種</th><th>完成</th><th>中央値</th><th>上位10%</th><th>最高</th><th>国宝以上</th><th>特異点</th><th>整った</th></tr>${kt}</table></div>
<p><small>器種は形の1番目の指標。「整った」は形の点数0.45以上（図鑑に入る形）。国宝以上は人間国宝か特異点。</small></p>
<h3 style="font-size:14px;margin:16px 0 4px">作ろうとして崩れた割合</h3>
<div style="overflow-x:auto"><table class="an"><tr><th>器種</th><th>回数</th><th>崩壊</th><th>崩壊率</th><th>理由</th></tr>${ct}</table></div>
<p><small>崩壊は、崩れる直前の形の1番目で数える。回数＝その器種の完成＋崩壊。</small></p>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="csv"><button>記録を CSV で保存（直近5万件）</button></form>`;
}
async function statsBody(env,k,a,id,ver,dt){
  const b=board(env);let r='';
  const hk0=`<input type="hidden" name="k" value="${esc(k)}">`;
  // 同じなまえの重複の整理：まず消す予定を見せ、「消す」を押したときだけ実行する
  if(a==='dedup'){
    const plan=await b.dedupeByName(false);
    const rows=plan.map(x=>`<tr><td class="l">${esc(x.label)}<small>${esc(x.u)}「${esc(x.n)}」</small></td><td>${yen(x.p)}</td><td class="l"><small>残す：「${esc(x.kn)}」${yen(x.kp)}</small></td></tr>`).join('');
    return page(`<h2>同じなまえの重複を整理</h2>
<p><small>同じなまえは同じ人とみなし、各番付（総合・器種別・逆番付）で なまえごとに一番良い1件だけ残します。名無しは対象外。消した記録は戻せません。</small></p>
<p><b>${plan.length}件</b>を消します。</p>
${plan.length?`<form class="k" method="post" action="/stats" onsubmit="return confirm('${plan.length}件を番付から消します。戻せません。よろしいですか？')">${hk0}<input type="hidden" name="a" value="dedup_go"><button style="background:#a12b12">${plan.length}件を消す</button></form>`:''}
<form class="k" method="post" action="/stats">${hk0}<input type="hidden" name="a" value="view"><button>やめて戻る</button></form>
<table style="margin-top:16px">${rows||'<tr><td>重複はありません</td></tr>'}</table>`);
  }
  if(a==='dedup_go'){const n=(await b.dedupeByName(true)).length;r=n?'dedup:'+n:'nodup';}
  if(a==='reset'){await b.resetStats();r='ok';}
  else if(a==='del'&&/^[0-9a-f]{8}$/.test(id))r=(await b.remove(id))?'del':'gone';
  const st=await b.stats(30),top=await b.top(),low=await b.low(),kinds=await b.kinds(),total=await b.total(),made=await b.made(),mk=await b.madeKinds(),an=await b.analyze(ver);
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
${analysisHtml(an,ver,hk)}
<h2>番付の記録（${rows.length}件）</h2>
<form class="k" method="post" action="/stats" style="margin-bottom:8px">${hk}<input type="hidden" name="a" value="dedup"><button>同じなまえの重複を整理（確認画面へ）</button></form>
<table>${rk||'<tr><td>まだ記録がありません</td></tr>'}</table>
<form class="k" method="post" action="/stats">${hk}<input type="hidden" name="a" value="view"><button>最新にする</button></form>
<h2>デバッグ</h2>
<p><small id="dbgst"></small></p>
<button type="button" id="dbgoff" style="background:#6e6458">この端末のデバッグを止める</button>
<script>
// 合言葉で開いたこの端末に、デバッグの札を置く（ゲームはサーバーに札を確かめてからデバッグを使えるようにする）
(function(){var t=${JSON.stringify(dt)},s=document.getElementById('dbgst'),o=document.getElementById('dbgoff');
function show(){var on=false;try{on=localStorage.getItem('rokuro_dbg_t')===t;}catch(e){}s.textContent=on?'この端末ではデバッグが使えます（ゲームを開き直すと有効。開始前に左上を5回タップ、または URL の末尾に ?debug）。':'この端末ではデバッグは使えません。';o.style.display=on?'':'none';}
if(t&&!sessionStorage.getItem('dbgoff')){try{localStorage.setItem('rokuro_dbg_t',t);}catch(e){}}
o.onclick=function(){try{localStorage.removeItem('rokuro_dbg_t');sessionStorage.setItem('dbgoff','1');}catch(e){}show();};
show();})();
</script>`);
}
export default {
  async fetch(req,env){
    const p=new URL(req.url).pathname;
    if(p==='/api/rank')return rank(req,env);
    if(p==='/api/play')return play(req,env);
    if(p==='/api/dbg')return dbgCheck(req,env);
    if(p==='/stats')return stats(req,env);
    return env.ASSETS.fetch(req);
  }
};
