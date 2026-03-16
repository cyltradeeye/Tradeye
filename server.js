var express = require(“express”);
var cors = require(“cors”);
var pg = require(“pg”);

var app = express();
var port = process.env.PORT || 3000;
var Pool = pg.Pool;

app.use(cors());
app.use(express.json());

var pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

function initDb() {
return pool.query(
“CREATE TABLE IF NOT EXISTS signals (” +
“id SERIAL PRIMARY KEY,” +
“coin_id TEXT NOT NULL,” +
“symbol TEXT NOT NULL,” +
“image TEXT NOT NULL,” +
“direction TEXT NOT NULL,” +
“entry_price TEXT NOT NULL,” +
“signal_score INTEGER NOT NULL,” +
“created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),” +
“resolved BOOLEAN NOT NULL DEFAULT FALSE,” +
“result TEXT,” +
“exit_price TEXT,” +
“pct_change TEXT,” +
“pts INTEGER);”
).then(function() {
return pool.query(“CREATE INDEX IF NOT EXISTS idx_s ON signals(coin_id,direction,created_at);”);
}).then(function() {
console.log(”[db] OK”);
});
}

var TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
var TG_CHAT = process.env.TELEGRAM_CHAT_ID;

function tg(text) {
if (!TG_TOKEN || !TG_CHAT) return Promise.resolve();
return fetch(“https://api.telegram.org/bot” + TG_TOKEN + “/sendMessage”, {
method: “POST”,
headers: { “Content-Type”: “application/json” },
body: JSON.stringify({ chat_id: TG_CHAT, text: text })
}).catch(function(e) { console.warn(”[tg]”, e.message); });
}

function fmtDate(d) {
return String(d.getDate()).padStart(2,“0”) + “/” +
String(d.getMonth()+1).padStart(2,“0”) + “/” +
d.getFullYear() + “ “ +
String(d.getHours()).padStart(2,“0”) + “:” +
String(d.getMinutes()).padStart(2,“0”);
}

function fmtPrice(p) {
if (p < 1) return p.toFixed(6);
if (p < 100) return p.toFixed(4);
return p.toFixed(2);
}

function scoreLong(c) {
var s = 0;
if (c.h1 > 0) { s += Math.min(40, (c.h1/5)*40); } else { s -= 20; }
if (c.d24 < -2 && c.h1 > 1) { s += 15; }
else if (c.d24 > 0 && c.h1 > 0) { s += Math.min(15, (c.d24/10)*15); }
if (c.vr > 0) { s += Math.min(20, (c.vr/0.4)*20); }
var avg = c.d24/24;
if (c.h1 > 0 && c.h1 > avg*2) s += 10;
if (c.d24 > 15 && c.h1 < 0.5) s -= 10;
if (c.d24 > 20) s -= 20;
return Math.max(0, Math.min(100, s));
}

function scoreShort(c) {
var s = 0;
if (c.h1 < 0) { s += Math.min(40, (Math.abs(c.h1)/5)*40); } else { s -= 20; }
if (c.d24 > 3 && c.h1 < -1) { s += 15; }
else if (c.d24 < -3 && c.h1 < 0) { s += Math.min(15, (Math.abs(c.d24)/10)*15); }
if (c.vr > 0 && c.h1 < 0) { s += Math.min(20, (c.vr/0.4)*20); }
var avg = c.d24/24;
if (c.h1 < 0 && c.h1 < avg*2) s += 10;
if (c.d24 < -15 && c.h1 < -3) s -= 12;
if (c.d24 < -20) s -= 20;
return Math.max(0, Math.min(100, s));
}

var RESOLVE_MS = 45*60*1000;
var MIN_SCORE = 60;

function sleep(ms) {
return new Promise(function(r) { setTimeout(r, ms); });
}

function fetchCoins() {
var p1, p2;
return fetch(“https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=1h,24h”)
.then(function(r) { return r.json(); })
.then(function(d) { p1 = d; return sleep(2000); })
.then(function() {
return fetch(“https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2&sparkline=false&price_change_percentage=1h,24h”);
})
.then(function(r) { return r.json(); })
.then(function(d) {
p2 = d;
return p1.concat(p2).map(function(c) {
return {
id: c.id,
sym: c.symbol.toUpperCase(),
img: c.image,
price: c.current_price || 0,
d24: c.price_change_percentage_24h || 0,
h1: c.price_change_percentage_1h_in_currency || 0,
vol: c.total_volume || 0,
mcap: c.market_cap || 0,
vr: c.market_cap > 0 ? c.total_volume/c.market_cap : 0
};
});
});
}

function resolveSignals(coins) {
var pm = {};
coins.forEach(function(c) { pm[c.id] = c.price; });
var cut = new Date(Date.now() - RESOLVE_MS);
return pool.query(“SELECT * FROM signals WHERE resolved=false AND created_at<=$1”, [cut])
.then(function(res) {
var tasks = res.rows.map(function(e) {
var cp = pm[e.coin_id];
if (!cp) return Promise.resolve();
var ep = parseFloat(e.entry_price);
var pct = ((cp-ep)/ep)*100;
var abs = Math.abs(pct);
var ok = (e.direction==“long”&&pct>0.1)||(e.direction==“short”&&pct<-0.1);
var neu = abs<=0.1;
var result, pts;
if (neu) { result=“neutral”; pts=5; }
else if (ok) { result=“correct”; pts=abs>=2?10:abs>=1?9:abs>=0.5?8:abs>=0.3?7:6; }
else { result=“incorrect”; pts=abs>=1?0:abs>=0.3?2:3; }
return pool.query(
“UPDATE signals SET resolved=true,result=$1,exit_price=$2,pct_change=$3,pts=$4 WHERE id=$5”,
[result, String(cp), String(pct), pts, e.id]
).then(function() {
var sign = pct>=0?”+”:””;
var icon = result==“correct”?“OK”:result==“incorrect”?“XX”:”->”;
console.log(”[cron]”, icon, e.symbol, e.direction, sign+pct.toFixed(2)+”%”, pts+“pts”);
var emoji = result==“correct”?“OK”:result==“incorrect”?“XX”:”->”;
return tg(emoji+” RESULTAT - “+e.symbol+” “+e.direction.toUpperCase()+
“\nEntree: $”+fmtPrice(ep)+” -> Sortie: $”+fmtPrice(cp)+
“\nVariation: “+sign+pct.toFixed(2)+”%\nScore: “+pts+”/10 pts”);
});
});
return Promise.all(tasks);
});
}

function logSignal(coin, dir, score) {
if (score < MIN_SCORE) return Promise.resolve();
var since = new Date(Date.now() - 60*60*1000);
var since2h = new Date(Date.now() - 2*60*60*1000);
var opp = dir==“long”?“short”:“long”;
return pool.query(
“SELECT id FROM signals WHERE coin_id=$1 AND direction=$2 AND created_at>=$3 AND resolved=false LIMIT 1”,
[coin.id, dir, since]
).then(function(r) {
if (r.rows.length > 0) return;
return pool.query(
“SELECT id FROM signals WHERE coin_id=$1 AND direction=$2 AND created_at>=$3 LIMIT 1”,
[coin.id, opp, since2h]
).then(function(r2) {
if (r2.rows.length > 0) {
console.log(”[cron] Skip”, coin.sym, dir, “- signal contraire recent”);
return;
}
var now = new Date();
return pool.query(
“INSERT INTO signals(coin_id,symbol,image,direction,entry_price,signal_score,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)”,
[coin.id, coin.sym, coin.img, dir, String(coin.price), score, now]
).then(function() {
console.log(”[cron] Signal:”, coin.sym, dir, “score=”+score, “@$”+coin.price);
var emoji = dir==“long”?“LONG”:“SHORT”;
return tg(emoji+” SIGNAL - “+coin.sym+
“\nScore: “+score+”/100\nPrix: $”+fmtPrice(coin.price)+
“\nDate: “+fmtDate(now)+”\nResolution dans 45min”);
});
});
});
}

var running = false;

function cycle() {
if (running) { console.log(”[cron] skip”); return; }
running = true;
console.log(”[cron] cycle”, new Date().toISOString());
fetchCoins()
.then(function(coins) {
console.log(”[cron]”, coins.length, “coins”);
return resolveSignals(coins).then(function() { return coins; });
})
.then(function(coins) {
var tr = coins.filter(function(c) { return c.vol > 3000000; });
var sc = tr.map(function(c) {
return Object.assign({}, c, { ls: scoreLong(c), ss: scoreShort(c) });
});
var bl = sc.slice().sort(function(a,b) { return b.ls-a.ls; })[0];
var bs = sc.slice().sort(function(a,b) { return b.ss-a.ss; })[0];
var tasks = [];
if (bl) tasks.push(logSignal(bl, “long”, Math.round(bl.ls)));
if (bs) tasks.push(logSignal(bs, “short”, Math.round(bs.ss)));
return Promise.all(tasks);
})
.catch(function(e) { console.error(”[cron] err:”, e.message); })
.then(function() { running = false; });
}

app.get(”/api/healthz”, function(req, res) { res.json({ status: “ok” }); });

app.get(”/api/test-telegram”, function(req, res) {
tg(“Test TRADEYE OK - “ + fmtDate(new Date()))
.then(function() { res.json({ success: true }); });
});

app.get(”/api/signals/history”, function(req, res) {
var since = new Date(Date.now() - 30*24*60*60*1000);
pool.query(“SELECT * FROM signals WHERE created_at>=$1 ORDER BY created_at DESC”, [since])
.then(function(r) { res.json({ success: true, data: r.rows }); })
.catch(function(e) { res.status(500).json({ success: false, error: e.message }); });
});

app.get(”/api/signals/perfo”, function(req, res) {
var since = new Date(Date.now() - 7*24*60*60*1000);
pool.query(“SELECT * FROM signals WHERE resolved=true AND created_at>=$1”, [since])
.then(function(r) {
var ok = r.rows.filter(function(x) { return x.result==“correct”; }).length;
var ko = r.rows.filter(function(x) { return x.result==“incorrect”; }).length;
var ne = r.rows.filter(function(x) { return x.result==“neutral”; }).length;
var wp = r.rows.filter(function(x) { return x.pts!=null; });
var sc = wp.length ? wp.reduce(function(s,x) { return s+x.pts; },0)/wp.length : null;
var wr = r.rows.length ? (ok/r.rows.length)*100 : null;
res.json({ success: true, data: { correct:ok, incorrect:ko, neutral:ne, total:r.rows.length, score7d:sc, winRate:wr }});
})
.catch(function(e) { res.status(500).json({ success: false, error: e.message }); });
});

app.get(”/api/signals/export”, function(req, res) {
var since = new Date(Date.now() - 30*24*60*60*1000);
pool.query(“SELECT * FROM signals WHERE created_at>=$1 ORDER BY created_at DESC”, [since])
.then(function(r) {
var resolved = r.rows.filter(function(x) { return x.resolved; });
var pending = r.rows.filter(function(x) { return !x.resolved; });
var ok = resolved.filter(function(x) { return x.result==“correct”; }).length;
var ko = resolved.filter(function(x) { return x.result==“incorrect”; }).length;
var ne = resolved.filter(function(x) { return x.result==“neutral”; }).length;
var wp = resolved.filter(function(x) { return x.pts!=null; });
var sc = wp.length ? (wp.reduce(function(s,x){return s+x.pts;},0)/wp.length).toFixed(1) : “-”;
var wr = resolved.length ? Math.round((ok/resolved.length)*100)+”%” : “-”;
var SEP = “==================================================\n”;
var txt = SEP+”  TRADEYE - HISTORIQUE (30 JOURS)\n  Exporte le “+fmtDate(new Date())+”\n”+SEP+”\n”;
txt += “SCORE 7J: “+sc+”/10 | WIN RATE: “+wr+”\n”;
txt += “CORRECTS: “+ok+” | INCORRECTS: “+ko+” | NEUTRES: “+ne+”\n\n”;
txt += SEP+”  EN COURS\n”+SEP+”\n”;
pending.forEach(function(x,i) {
var age = Math.floor((Date.now()-new Date(x.created_at))/60000);
txt += “[”+(i+1)+”] “+x.symbol+” “+x.direction.toUpperCase()+” Score:”+x.signal_score+” il y a “+age+“min\n”;
txt += “    Entree: $”+x.entry_price+”\n\n”;
});
txt += SEP+”  RESOLUS\n”+SEP+”\n”;
resolved.forEach(function(x,i) {
var icon = x.result==“correct”?“OK”:x.result==“neutral”?”->”:“XX”;
var pct = parseFloat(x.pct_change||“0”);
var sign = pct>=0?”+”:””;
txt += “[”+(i+1)+”] “+icon+” “+x.symbol+” “+x.direction.toUpperCase()+”\n”;
txt += “    Date: “+fmtDate(new Date(x.created_at))+”\n”;
txt += “    “+sign+pct.toFixed(2)+”% | “+(x.pts||”-”)+”/10 pts\n\n”;
});
txt += SEP+”  FIN DU RAPPORT\n”+SEP;
res.setHeader(“Content-Type”, “text/plain; charset=utf-8”);
res.setHeader(“Content-Disposition”, “attachment; filename=tradeye_”+new Date().toISOString().slice(0,10)+”.txt”);
res.send(txt);
})
.catch(function(e) { res.status(500).json({ success: false, error: e.message }); });
});

initDb().then(function() {
app.listen(port, function() { console.log(”[server] Port”, port); });
console.log(”[cron] Start 3min”);
cycle();
setInterval(cycle, 180000);
}).catch(console.error);
