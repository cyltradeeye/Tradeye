“use strict”;
const express = require(“express”);
const cors = require(“cors”);
const { Pool } = require(“pg”);

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

async function initDb() {
await pool.query(“CREATE TABLE IF NOT EXISTS signals (id SERIAL PRIMARY KEY, coin_id TEXT NOT NULL, symbol TEXT NOT NULL, image TEXT NOT NULL, direction TEXT NOT NULL, entry_price TEXT NOT NULL, signal_score INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved BOOLEAN NOT NULL DEFAULT FALSE, result TEXT, exit_price TEXT, pct_change TEXT, pts INTEGER);”);
await pool.query(“CREATE INDEX IF NOT EXISTS idx_signals ON signals (coin_id, direction, created_at);”);
console.log(”[db] OK”);
}

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

async function tg(text) {
if (!TG_TOKEN || !TG_CHAT) return;
try {
await fetch(“https://api.telegram.org/bot” + TG_TOKEN + “/sendMessage”, {
method: “POST”,
headers: { “Content-Type”: “application/json” },
body: JSON.stringify({ chat_id: TG_CHAT, text: text })
});
} catch(e) { console.warn(”[tg] err:”, e.message); }
}

function fmtDate(d) {
return String(d.getDate()).padStart(2,“0”) + “/” + String(d.getMonth()+1).padStart(2,“0”) + “/” + d.getFullYear() + “ “ + String(d.getHours()).padStart(2,“0”) + “:” + String(d.getMinutes()).padStart(2,“0”);
}

function fmtPrice(p) {
return p < 1 ? p.toFixed(6) : p < 100 ? p.toFixed(4) : p.toFixed(2);
}

function scoreLong(c) {
let s = 0;
if (c.h1 > 0) { s += Math.min(40, (c.h1/5)*40); } else { s -= 20; }
if (c.d24 < -2 && c.h1 > 1) { s += 15; }
else if (c.d24 > 0 && c.h1 > 0) { s += Math.min(15, (c.d24/10)*15); }
if (c.vr > 0) { s += Math.min(20, (c.vr/0.4)*20); }
const avg = c.d24/24;
if (c.h1 > 0 && c.h1 > avg*2) s += 10;
if (c.d24 > 15 && c.h1 < 0.5) s -= 10;
if (c.d24 > 20) s -= 20;
return Math.max(0, Math.min(100, s));
}

function scoreShort(c) {
let s = 0;
if (c.h1 < 0) { s += Math.min(40, (Math.abs(c.h1)/5)*40); } else { s -= 20; }
if (c.d24 > 3 && c.h1 < -1) { s += 15; }
else if (c.d24 < -3 && c.h1 < 0) { s += Math.min(15, (Math.abs(c.d24)/10)*15); }
if (c.vr > 0 && c.h1 < 0) { s += Math.min(20, (c.vr/0.4)*20); }
const avg = c.d24/24;
if (c.h1 < 0 && c.h1 < avg*2) s += 10;
if (c.d24 < -15 && c.h1 < -3) s -= 12;
if (c.d24 < -20) s -= 20;
return Math.max(0, Math.min(100, s));
}

const RESOLVE_MS = 30*60*1000;
const MIN_SCORE = 55;

function sleep(ms) { return new Promise(function(r){ setTimeout(r,ms); }); }

async function fetchCoins() {
const p1 = await (await fetch(“https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=1h,24h”)).json();
await sleep(2000);
const p2 = await (await fetch(“https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2&sparkline=false&price_change_percentage=1h,24h”)).json();
return p1.concat(p2).map(function(c) {
return { id: c.id, sym: c.symbol.toUpperCase(), img: c.image, price: c.current_price||0, d24: c.price_change_percentage_24h||0, h1: c.price_change_percentage_1h_in_currency||0, vol: c.total_volume||0, mcap: c.market_cap||0, vr: c.market_cap>0 ? c.total_volume/c.market_cap : 0 };
});
}

async function resolve(coins) {
const pm = {};
coins.forEach(function(c){ pm[c.id]=c.price; });
const cut = new Date(Date.now()-RESOLVE_MS);
const r = await pool.query(“SELECT * FROM signals WHERE resolved=false AND created_at<=$1”,[cut]);
for (const e of r.rows) {
const cp = pm[e.coin_id];
if (!cp) continue;
const ep = parseFloat(e.entry_price);
const pct = ((cp-ep)/ep)*100;
const abs = Math.abs(pct);
const ok = (e.direction==“long”&&pct>0.1)||(e.direction==“short”&&pct<-0.1);
const neu = abs<=0.1;
let res, pts;
if (neu){res=“neutral”;pts=5;}
else if(ok){res=“correct”;pts=abs>=2?10:abs>=1?9:abs>=0.5?8:abs>=0.3?7:6;}
else{res=“incorrect”;pts=abs>=1?0:abs>=0.3?2:3;}
await pool.query(“UPDATE signals SET resolved=true,result=$1,exit_price=$2,pct_change=$3,pts=$4 WHERE id=$5”,[res,String(cp),String(pct),pts,e.id]);
const sign=pct>=0?”+”:””;
const emoji=res==“correct”?“OK”:res==“incorrect”?“XX”:”->”;
console.log(”[cron] “+emoji+” “+e.symbol+” “+e.direction+” “+sign+pct.toFixed(2)+”% “+pts+“pts”);
await tg(emoji+” RESULTAT - “+e.symbol+” “+e.direction.toUpperCase()+”\nEntree: $”+fmtPrice(ep)+” -> Sortie: $”+fmtPrice(cp)+”\nVariation: “+sign+pct.toFixed(2)+”%\nScore: “+pts+”/10 pts”);
}
}

async function logSig(coin, dir, score) {
if (score<MIN_SCORE) return;
const since = new Date(Date.now()-RESOLVE_MS);
const r = await pool.query(“SELECT id FROM signals WHERE coin_id=$1 AND direction=$2 AND created_at>=$3 AND resolved=false LIMIT 1”,[coin.id,dir,since]);
if (r.rows.length>0) return;
const now = new Date();
await pool.query(“INSERT INTO signals (coin_id,symbol,image,direction,entry_price,signal_score,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)”,[coin.id,coin.sym,coin.img,dir,String(coin.price),score,now]);
console.log(”[cron] Signal: “+coin.sym+” “+dir+” score=”+score+” @ $”+coin.price);
const emoji = dir==“long”?“LONG”:“SHORT”;
await tg(emoji+” SIGNAL - “+coin.sym+”\nScore: “+score+”/100\nPrix: $”+fmtPrice(coin.price)+”\nDate: “+fmtDate(now)+”\nResolution dans 30min”);
}

let running = false;
async function cycle() {
if (running){console.log(”[cron] skip”);return;}
running=true;
console.log(”[cron] cycle “+new Date().toISOString());
try {
const coins = await fetchCoins();
console.log(”[cron] “+coins.length+” coins”);
await resolve(coins);
const tr = coins.filter(function(c){return c.vol>3000000;});
const sc = tr.map(function(c){return Object.assign({},c,{ls:scoreLong(c),ss:scoreShort(c)});});
const bl = sc.slice().sort(function(a,b){return b.ls-a.ls;})[0];
const bs = sc.slice().sort(function(a,b){return b.ss-a.ss;})[0];
if(bl) await logSig(bl,“long”,Math.round(bl.ls));
if(bs) await logSig(bs,“short”,Math.round(bs.ss));
} catch(e) {
console.error(”[cron] err:”,e.message);
} finally { running=false; }
}

app.get(”/api/healthz”,function(_q,r){r.json({status:“ok”});});
app.get(”/api/signals/history”,async function(_q,res){
try{const r=await pool.query(“SELECT * FROM signals WHERE created_at>=$1 ORDER BY created_at DESC”,[new Date(Date.now()-30*24*60*60*1000)]);res.json({success:true,data:r.rows});}
catch(e){res.status(500).json({success:false,error:e.message});}
});
app.get(”/api/signals/perfo”,async function(*q,res){
try{
const r=await pool.query(“SELECT * FROM signals WHERE resolved=true AND created_at>=$1”,[new Date(Date.now()-7*24*60*60*1000)]);
const ok=r.rows.filter(function(x){return x.result==“correct”;}).length;
const ko=r.rows.filter(function(x){return x.result==“incorrect”;}).length;
const ne=r.rows.filter(function(x){return x.result==“neutral”;}).length;
const wp=r.rows.filter(function(x){return x.pts!=null;});
const sc=wp.length?wp.reduce(function(s,x){return s+x.pts;},0)/wp.length:null;
res.json({success:true,data:{correct:ok,incorrect:ko,neutral:ne,total:r.rows.length,score7d:sc,winRate:r.rows.length?(ok/r.rows.length)*100:null}});
}catch(e){res.status(500).json({success:false,error:e.message});}
});
app.get(”/api/signals/export”,async function(_q,res){
try{
const r=await pool.query(“SELECT * FROM signals WHERE created_at>=$1 ORDER BY created_at DESC”,[new Date(Date.now()-30*24*60*60*1000)]);
const resolved=r.rows.filter(function(x){return x.resolved;});
const pending=r.rows.filter(function(x){return !x.resolved;});
const ok=resolved.filter(function(x){return x.result==“correct”;}).length;
const ko=resolved.filter(function(x){return x.result==“incorrect”;}).length;
const ne=resolved.filter(function(x){return x.result==“neutral”;}).length;
const wp=resolved.filter(function(x){return x.pts!=null;});
const sc=wp.length?(wp.reduce(function(s,x){return s+x.pts;},0)/wp.length).toFixed(1):”-”;
const wr=resolved.length?Math.round((ok/resolved.length)*100)+”%”:”-”;
const SEP=”==================================================\n”;
let txt=SEP+”  TRADEYE - HISTORIQUE (30 JOURS)\n  Exporte le “+fmtDate(new Date())+”\n”+SEP+”\n”;
txt+=“SCORE 7J: “+sc+”/10 | WIN RATE: “+wr+”\n”;
txt+=“CORRECTS: “+ok+” | INCORRECTS: “+ko+” | NEUTRES: “+ne+”\n\n”;
txt+=SEP+”  EN COURS\n”+SEP+”\n”;
pending.forEach(function(x,i){const age=Math.floor((Date.now()-new Date(x.created_at))/60000);txt+=”[”+(i+1)+”] “+x.symbol+” “+x.direction.toUpperCase()+” Score:”+x.signal_score+” il y a “+age+“min\n    Entree: $”+x.entry_price+”\n\n”;});
txt+=SEP+”  RESOLUS\n”+SEP+”\n”;
resolved.forEach(function(x,i){const icon=x.result==“correct”?“OK”:x.result==“neutral”?”->”:“XX”;const pct=parseFloat(x.pct_change||“0”);const sign=pct>=0?”+”:””;txt+=”[”+(i+1)+”] “+icon+” “+x.symbol+” “+x.direction.toUpperCase()+” Score:”+x.signal_score+”\n    Date: “+fmtDate(new Date(x.created_at))+”\n    “+sign+pct.toFixed(2)+”% | “+(x.pts||”-”)+”/10 pts\n\n”;});
txt+=SEP+”  FIN DU RAPPORT\n”+SEP;
res.setHeader(“Content-Type”,“text/plain; charset=utf-8”);
res.setHeader(“Content-Disposition”,“attachment; filename=tradeye*”+new Date().toISOString().slice(0,10)+”.txt”);
res.send(txt);
}catch(e){res.status(500).json({success:false,error:e.message});}
});

async function main() {
await initDb();
app.listen(port,function(){console.log(”[server] Port “+port);});
console.log(”[cron] Start 3min”);
cycle();
setInterval(function(){cycle();},180000);
}
main().catch(console.error);
