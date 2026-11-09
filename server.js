'use strict';

/**
 * 全市场指数与板块资金流向监控台 —— 后端
 * 零第三方依赖：静态托管 + 东方财富公开行情接口代理 + 字段归一化 + 缓存
 * 重要：上游不可用时返回空状态，绝不使用模拟数据替代真实行情。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const QUOTE_URL = 'https://push2.eastmoney.com/api/qt/stock/get';
const TRENDS_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get';
const CLIST_URL = 'https://push2.eastmoney.com/api/qt/clist/get';
const UT = 'b2884a393a59ad64002292a3e90d46a5';

const INDICES = [
  { key: 'sh',  secid: '1.000001', name: '上证指数', code: '000001.SH', session: 'a',  minutes: 241, axis: ['09:30', '10:30', '11:30 / 13:00', '14:00', '15:00'] },
  { key: 'hsi', secid: '100.HSI',  name: '恒生指数', code: 'HSI.HK',    session: 'hk', minutes: 331, axis: ['09:30', '10:30', '12:00 / 13:00', '14:30', '16:00'] },
  { key: 'cyb', secid: '0.399006', name: '创业板指', code: '399006.SZ', session: 'a',  minutes: 241, axis: ['09:30', '10:30', '11:30 / 13:00', '14:00', '15:00'] }
];

const SECTOR_TYPES = {
  industry: { t: 2, label: '行业板块' },
  concept:  { t: 3, label: '概念板块' },
  region:   { t: 1, label: '地域板块' }
};

const SOURCE_QUOTE = '东方财富行情接口 push2.eastmoney.com / push2his.eastmoney.com';
const SOURCE_FLOW = '东方财富板块资金流接口 push2.eastmoney.com（公开入口 data.eastmoney.com/bkzj/hy.html）';
const FLOW_NOTE = '主力净额 = 超大单净额 + 大单净额，是按单笔成交规模分档的方向性差额估算值，非交易所官方数据、也非增量资金。';
const OVERLAP_NOTE = '行业板块含东财一级/二级/三级分级行业，成分存在层级重叠，各行金额不可直接相加代表全市场总额；本页已对数值完全相同的重复口径条目去重。';
const SCORE_NOTE = '排序指标 = 当日涨跌幅(%) × 板块流通总市值，换算为亿元；为按该口径计算的估算值，不等于真实市值变动额。';

/* ---------------- 北京时间与交易状态 ---------------- */

function bjParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', weekday: 'short', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hour12: false
  });
  const out = {};
  for (const part of fmt.formatToParts(date || new Date())) out[part.type] = part.value;
  return out;
}

function beijingNow() {
  const p = bjParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function bjTimeStr(unixSec) {
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = bjParts(new Date(n * 1000));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function marketStatus() {
  const p = bjParts();
  const weekend = p.weekday === 'Sat' || p.weekday === 'Sun';
  const mins = Number(p.hour) * 60 + Number(p.minute);
  const session = (amStart, amEnd, pmStart, pmEnd) => {
    if (weekend) return '休市';
    if (mins < amStart) return '盘前';
    if (mins < amEnd) return '盘中';
    if (mins < pmStart) return '午间休市';
    if (mins < pmEnd) return '盘中';
    return '盘后';
  };
  const aShare = session(570, 690, 780, 900);   // 09:30-11:30 / 13:00-15:00
  const hk = session(570, 720, 780, 960);       // 09:30-12:00 / 13:00-16:00
  return {
    beijingTime: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`,
    aShare, hk,
    trading: aShare === '盘中' || hk === '盘中',
    note: '仅按北京时间交易时段与周末判断，法定节假日以交易所公告为准；非交易时段展示最近交易日收盘数据。'
  };
}

/* ---------------- 上游请求与缓存 ---------------- */

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://quote.eastmoney.com/' }
    });
    if (!res.ok) throw new Error('上游 HTTP ' + res.status);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('上游返回非 JSON'); }
    if (json.rc !== undefined && json.rc !== 0) throw new Error('上游 rc=' + json.rc);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map();
const inflight = new Map();

async function withCache(key, ttlMs, producer, force) {
  const hit = cache.get(key);
  // force=1（手动刷新）跳过缓存且不写入缓存，避免影响自动刷新节奏
  if (!force && hit && Date.now() < hit.expires) return { ...hit.data, cache: 'hit' };
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    try {
      const data = await producer();
      const payload = { ...data, fetchedAt: beijingNow() };
      if (!force) cache.set(key, { data: payload, expires: Date.now() + ttlMs });
      return { ...payload, cache: 'miss' };
    } catch (err) {
      // 手动刷新失败要如实报错；自动刷新才允许降级到上次缓存
      if (!force && hit) return { ...hit.data, cache: 'stale', upstreamError: String(err && err.message || err) };
      throw err;
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

function num(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- 指数：实时报价 + 分时 + 分时量 ---------------- */

const QUOTE_FIELDS = 'f43,f44,f45,f46,f47,f48,f57,f58,f59,f60,f86,f169,f170';
const TREND_FIELDS1 = 'f1,f2,f3,f4,f5,f6,f7,f8';
const TREND_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58';

async function fetchIndex(cfg) {
  const qUrl = `${QUOTE_URL}?secid=${encodeURIComponent(cfg.secid)}&fields=${QUOTE_FIELDS}`;
  const tUrl = `${TRENDS_URL}?secid=${encodeURIComponent(cfg.secid)}&fields1=${TREND_FIELDS1}&fields2=${TREND_FIELDS2}&ndays=1&iscr=0`;
  const [q, t] = await Promise.all([getJson(qUrl), getJson(tUrl)]);
  if (!q.data || !t.data) throw new Error('上游指数数据为空');

  const d = q.data;
  const decimal = num(d.f59) === null ? 2 : Number(d.f59);
  const scale = Math.pow(10, decimal);
  const price = v => { const n = num(v); return n === null ? null : n / scale; };
  const pct = v => { const n = num(v); return n === null ? null : n / 100; };

  const trends = Array.isArray(t.data.trends) ? t.data.trends : [];
  const points = trends.map(row => {
    const a = String(row).split(',');
    return {
      time: String(a[0] || '').slice(11, 16),
      price: num(a[2]),
      avg: num(a[7]) || null,
      volume: num(a[5]) || 0,
      amount: num(a[6]) || 0
    };
  }).filter(p => p.price !== null);

  const quoteTime = bjTimeStr(d.f86);
  const lastPrice = price(d.f43);
  const m = marketStatus();
  const isLive = cfg.session === 'a' ? m.aShare === '盘中' : m.hk === '盘中';

  // 盘中：分时序列末端是分钟级快照，用同一来源的真实实时报价驱动最后一笔，
  // 使 1 秒刷新时曲线末端跟着最新价跳动；保留原始值 rawPrice 供核对，不编造数值。
  let livePoint = null;
  if (isLive && points.length && lastPrice !== null) {
    const tail = points[points.length - 1];
    const rawPrice = tail.price;
    tail.price = lastPrice;
    tail.rawPrice = rawPrice;
    tail.live = true;

    // 实时累计成交量与分时各分钟成交量同口径；上游分时若略滞后，把差额补到当前分钟
    const sumV = points.reduce((s, p) => s + (p.volume || 0), 0);
    const qVol = num(d.f47);
    if (qVol !== null && sumV > 0) {
      const extra = qVol - sumV;
      if (extra > 0 && extra < sumV * 0.05) {
        tail.volume = (tail.volume || 0) + extra;
        tail.liveVolume = true;
      }
    }
    livePoint = { time: tail.time, price: lastPrice, rawPrice, quoteTime };
  }

  return {
    available: true,
    quote: {
      last: lastPrice, open: price(d.f46), high: price(d.f44), low: price(d.f45),
      prevClose: price(d.f60), change: price(d.f169), changePct: pct(d.f170),
      volume: num(d.f47), amount: num(d.f48),
      quoteTime
    },
    trends: {
      preClose: num(t.data.preClose),
      decimal,
      minutes: cfg.minutes,
      isLive,
      livePoint,
      date: trends.length ? String(trends[0]).slice(0, 10) : null,
      points
    }
  };
}

async function fetchIndices() {
  const settled = await Promise.allSettled(INDICES.map(fetchIndex));
  const indices = INDICES.map((cfg, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled') return { ...cfg, ...r.value };
    return { ...cfg, available: false, error: String(r.reason && r.reason.message || r.reason) };
  });
  if (indices.every(x => !x.available)) throw new Error('三大指数行情全部获取失败');
  return { indices, source: SOURCE_QUOTE, indexNote: '盘中分时末端由实时报价驱动、横轴按全天交易分钟铺展（右侧留白为剩余时段），含价格线、均价线与每分钟分时量；休市时为最近交易日完整分时。' };
}

/* ---------------- 板块：全市场分页取数 + 排序指标 ---------------- */

const SECTOR_FIELDS = 'f12,f14,f2,f3,f6,f8,f20,f21,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f124';

async function fetchSectorPage(t, pn) {
  const fsParam = encodeURIComponent(`m:90+t:${t}`);
  const url = `${CLIST_URL}?fid=f62&po=1&pz=100&pn=${pn}&np=1&fltt=2&invt=2&ut=${UT}&fs=${fsParam}&fields=${SECTOR_FIELDS}`;
  const json = await getJson(url);
  if (!json.data || !Array.isArray(json.data.diff)) throw new Error('上游板块数据为空');
  return { total: Number(json.data.total) || json.data.diff.length, diff: json.data.diff };
}

function normalizeSector(r) {
  const changePct = num(r.f3);
  const floatCap = num(r.f21);
  const marketCap = num(r.f20);
  const mainNet = num(r.f62) ?? 0;
  const score = (changePct === null || floatCap === null) ? null : (changePct / 100) * floatCap;
  return {
    code: String(r.f12 || ''),
    name: String(r.f14 || ''),
    price: num(r.f2),
    changePct,
    turnoverRate: num(r.f8),
    amount: num(r.f6),
    marketCap,
    floatCap,
    mainNet,
    mainPct: num(r.f184),
    superNet: num(r.f66),
    bigNet: num(r.f72),
    midNet: num(r.f78),
    smallNet: num(r.f84),
    score,
    scoreYi: score === null ? null : score / 1e8
  };
}

async function fetchSectors(type) {
  const cfg = SECTOR_TYPES[type];
  const first = await fetchSectorPage(cfg.t, 1);
  const total = first.total;
  const pages = Math.ceil(total / 100);
  let failedPages = 0;
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
      fetchSectorPage(cfg.t, i + 2).catch(() => { failedPages += 1; return { diff: [] }; })
    )
  );
  const raw = [first.diff, ...rest.map(p => p.diff)].flat();

  // 分级行业里存在数值完全相同的重复口径条目（如「银行」与「银行Ⅱ」），保留名称更短的一条
  const dedup = new Map();
  for (const r of raw) {
    if (!r || !r.f12) continue;
    const item = normalizeSector(r);
    const key = `${item.changePct}|${item.floatCap}|${item.mainNet}`;
    const prev = dedup.get(key);
    if (!prev || item.name.length < prev.name.length) dedup.set(key, item);
  }
  const items = Array.from(dedup.values()).filter(x => x.code && x.name);
  items.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  const dataTime = bjTimeStr(raw.length ? raw[0].f124 : null);
  let inflowTotal = 0, outflowTotal = 0, inflowCount = 0, outflowCount = 0, flatCount = 0, maxAbsFlow = 0, maxAbsScore = 0;
  for (const it of items) {
    if (it.mainNet > 0) { inflowTotal += it.mainNet; inflowCount += 1; }
    else if (it.mainNet < 0) { outflowTotal += it.mainNet; outflowCount += 1; }
    else flatCount += 1;
    maxAbsFlow = Math.max(maxAbsFlow, Math.abs(it.mainNet));
    maxAbsScore = Math.max(maxAbsScore, Math.abs(it.score || 0));
  }

  return {
    type, label: cfg.label,
    source: SOURCE_FLOW,
    dataTime,
    rawTotal: total,
    count: items.length,
    complete: raw.length === total && failedPages === 0,
    returned: raw.length,
    items,
    summary: { inflowTotal, outflowTotal, netTotal: inflowTotal + outflowTotal, inflowCount, outflowCount, flatCount, maxAbsFlow, maxAbsScore },
    notes: { score: SCORE_NOTE, flow: FLOW_NOTE, overlap: OVERLAP_NOTE }
  };
}

/* ---------------- HTTP 层 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = pathname; }
  if (!rel || rel === '/') rel = '/index.html';
  const full = path.resolve(PUBLIC_DIR, '.' + rel);
  const root = path.resolve(PUBLIC_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: '文件不存在', path: rel });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': stat.size
    });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); }
  catch { return sendJson(res, 400, { error: '请求格式错误' }); }
  const p = u.pathname;

  try {
    const m = marketStatus();
    // 盘中/休市用不同缓存键，状态切换时不会读到上一状态的旧缓存
    const phase = m.trading ? 'live' : 'closed';
    const force = u.searchParams.get('force') === '1';
    if (p === '/api/indices') {
      // 盘中 0.9s < 前端 1s；休市 60s < 前端 120s；force=1 由 withCache 跳过缓存
      const ttl = m.trading ? 900 : 60000;
      const payload = await withCache('indices:' + phase, ttl, fetchIndices, force);
      return sendJson(res, 200, { ...payload, market: marketStatus() });
    }
    if (p === '/api/sectors') {
      const type = u.searchParams.get('type') || 'industry';
      if (!SECTOR_TYPES[type]) return sendJson(res, 400, { error: '未知板块类型', detail: type });
      const ttl = m.trading ? 4500 : 60000;
      const payload = await withCache('sectors:' + phase + ':' + type, ttl, () => fetchSectors(type), force);
      return sendJson(res, 200, { ...payload, market: marketStatus() });
    }
    if (p === '/api/health') {
      return sendJson(res, 200, { ok: true, time: beijingNow(), market: marketStatus(), sources: [SOURCE_QUOTE, SOURCE_FLOW] });
    }
    return serveStatic(res, p);
  } catch (err) {
    return sendJson(res, 503, {
      error: '上游数据源暂不可用（页面不展示任何模拟数据）',
      detail: String(err && err.message || err),
      time: beijingNow()
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[market-dashboard] http://${HOST}:${PORT}  北京时间 ${beijingNow()}`);
  console.log(`[market-dashboard] 数据源：${SOURCE_QUOTE} / ${SOURCE_FLOW}`);
});
