'use strict';

/* 全市场指数与行业板块资金监控台 —— 前端
 * 所有数值均由后端 /api/* 提供，不使用任何模拟数据。
 */

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const UP = '#d8434b';
const DOWN = '#159361';
const BLUE = '#4a7fd0';
const AVG = '#d6a441';
const REDS = ['#d8434b', '#e0666d', '#e88a90', '#f0a9ad', '#f3c0c2', '#cf5b7d', '#dd84a1', '#e9a8bd', '#c97070', '#e2a0a0'];
const BLUES = ['#4a7fd0', '#6a94dd', '#89ACEA', '#a6c1ef', '#bfd3f5', '#5f7fc0', '#7d9fd8', '#9db9e6', '#6a8bbc', '#afc7ee'];

const state = {
  indices: null,
  sectors: null,
  order: 'up',        // up = 涨最多排前面（降序），down = 跌最多排前面（升序）
  type: 'industry',
  limit: 10,
  cards: new Map(),
  rowItems: new Map()
};

/* ---------------- 格式化 ---------------- */

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function finite(v) { return v !== null && v !== undefined && Number.isFinite(Number(v)); }
function fmtNum(v, d) {
  const digits = d === undefined ? 2 : d;
  if (!finite(v)) return '—';
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function signed(v, d) {
  if (!finite(v)) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : n < 0 ? '−' : '') + fmtNum(Math.abs(n), d === undefined ? 2 : d);
}
function pct(v) { return finite(v) ? signed(v, 2) + '%' : '—'; }
function money(v) { // 元 -> 亿 / 万亿
  if (!finite(v)) return '—';
  const n = Number(v);
  return Math.abs(n) >= 1e12 ? fmtNum(n / 1e12, 2) + '万亿' : fmtNum(n / 1e8, 2) + '亿';
}
function yi(v, withSign) { // 元 -> 亿
  if (!finite(v)) return '—';
  const n = Number(v) / 1e8;
  const sign = withSign === false ? '' : (n > 0 ? '+' : n < 0 ? '−' : '');
  return sign + fmtNum(Math.abs(n), 2);
}
function cls(v) {
  if (!finite(v) || Number(v) === 0) return 'flat';
  return Number(v) > 0 ? 'up' : 'down';
}
function hexA(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

async function api(url) {
  const res = await fetch(url, { cache: 'no-store' });
  let json;
  try { json = await res.json(); } catch { throw new Error('后端返回非 JSON'); }
  if (!res.ok) throw new Error(json.detail || json.error || ('HTTP ' + res.status));
  return json;
}

/* ---------------- 顶部状态栏 ---------------- */

function renderMarket(m) {
  if (!m) return;
  const pill = m.trading ? '<b class="pill live">交易中</b>' : '<b class="pill closed">休市</b>';
  $('#market-status').innerHTML = `${pill}<span>A股 ${esc(m.aShare)} · 港股 ${esc(m.hk)}</span><em>${esc(m.note)}</em>`;
}
function tickClock() {
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
  $('#clock').textContent = '北京时间 ' + t;
}

/* ---------------- 指数分时图（Canvas） ---------------- */

function drawTrend(card) {
  const st = state.cards.get(card.dataset.key);
  const canvas = card.querySelector('canvas');
  const tip = card.querySelector('.trend-tip');
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(20, Math.round(rect.width));
  const h = Math.max(20, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cfg = st && st.cfg;
  const pts = cfg && cfg.available && cfg.trends ? cfg.trends.points : [];
  if (!pts.length) {
    ctx.fillStyle = '#a3a8b1';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(cfg && !cfg.available ? '数据源暂不可用' : '正在加载分时数据…', w / 2, h / 2);
    tip.style.display = 'none';
    return;
  }

  const padL = 4, padR = 44, padT = 5, padB = 2;
  const plotW = w - padL - padR;
  const priceH = (h - padT - padB) * 0.72;
  const volTop = padT + priceH + 5;
  const volH = Math.max(6, h - padB - volTop);
  const q = cfg.quote || {};
  const pre = cfg.trends.preClose || q.prevClose || pts[0].price;

  let dev = 0;
  for (const p of pts) {
    dev = Math.max(dev, Math.abs(p.price - pre));
    if (p.avg) dev = Math.max(dev, Math.abs(p.avg - pre));
  }
  dev = dev * 1.15 || pre * 0.005;
  const yTop = pre + dev, yBot = pre - dev;
  const yOf = v => padT + (yTop - v) / (yTop - yBot) * priceH;
  const xOf = i => padL + (pts.length < 2 ? 0 : i / (pts.length - 1) * plotW);
  const color = (q.changePct || 0) >= 0 ? UP : DOWN;

  // 网格
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + i * priceH / 4;
    ctx.strokeStyle = i === 2 ? '#ded3bb' : '#f1ece1';
    ctx.setLineDash(i === 2 ? [3, 3] : []);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
  }
  for (let i = 0; i <= 4; i++) {
    const x = padL + i * plotW / 4;
    ctx.strokeStyle = '#f4f0e7';
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + priceH); ctx.stroke();
  }
  ctx.setLineDash([]);

  // 坐标标签
  ctx.font = '9px "Segoe UI", sans-serif';
  ctx.fillStyle = '#a3a8b1';
  ctx.textAlign = 'left';
  ctx.fillText(fmtNum(yTop, 2), padL + 1, padT + 9);
  ctx.fillText(fmtNum(yBot, 2), padL + 1, padT + priceH - 2);
  ctx.textAlign = 'right';
  ctx.fillStyle = hexA(UP, 0.8);
  ctx.fillText('+' + (dev / pre * 100).toFixed(2) + '%', w - 2, padT + 9);
  ctx.fillStyle = hexA(DOWN, 0.8);
  ctx.fillText('−' + (dev / pre * 100).toFixed(2) + '%', w - 2, padT + priceH - 2);
  ctx.fillStyle = '#a3a8b1';
  ctx.fillText(fmtNum(pre, 2), w - 2, padT + priceH / 2 - 2);

  // 价格面积 + 价格线
  const grad = ctx.createLinearGradient(0, padT, 0, padT + priceH);
  grad.addColorStop(0, hexA(color, 0.20));
  grad.addColorStop(1, hexA(color, 0.01));
  ctx.beginPath();
  ctx.moveTo(xOf(0), padT + priceH);
  pts.forEach((p, i) => ctx.lineTo(xOf(i), yOf(p.price)));
  ctx.lineTo(xOf(pts.length - 1), padT + priceH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = xOf(i), y = yOf(p.price);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 均价线（港股接口部分时段无均价，缺失则跳过）
  const avgCount = pts.filter(p => p.avg && p.avg > 0).length;
  if (avgCount > pts.length * 0.4) {
    ctx.beginPath();
    let started = false;
    pts.forEach((p, i) => {
      if (!p.avg || p.avg <= 0) { started = false; return; }
      const x = xOf(i), y = yOf(p.avg);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = AVG;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 分时量（每分钟成交量，红涨绿跌）
  const maxV = Math.max(1, ...pts.map(p => p.volume));
  const bw = Math.max(1, Math.min(4, plotW / Math.max(1, pts.length) * 0.7));
  ctx.strokeStyle = '#eee7d9';
  ctx.beginPath(); ctx.moveTo(padL, volTop - 3); ctx.lineTo(padL + plotW, volTop - 3); ctx.stroke();
  pts.forEach((p, i) => {
    const bh = Math.min(volH, p.volume / maxV * volH);
    const rising = i === 0 ? p.price >= pre : p.price >= pts[i - 1].price;
    ctx.fillStyle = hexA(rising ? UP : DOWN, 0.58);
    ctx.fillRect(xOf(i) - bw / 2, volTop + volH - bh, bw, bh);
  });

  // 十字光标
  if (st && st.hover >= 0 && st.hover < pts.length) {
    const i = st.hover;
    const p = pts[i];
    const x = xOf(i), y = yOf(p.price);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#8b93a1';
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, volTop + volH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    const cp = (p.price - pre) / pre * 100;
    tip.innerHTML = `<b>${esc(p.time)}</b> 价 ${fmtNum(p.price, 2)} · ${signed(cp, 2)}%<br>分时量 ${fmtNum(p.volume / 1e4, 0)}万手` +
      (p.avg ? ` · 均价 ${fmtNum(p.avg, 2)}` : '');
    tip.style.display = 'block';
    tip.style.left = (x > w * 0.62 ? '6px' : Math.max(4, Math.min(w - 150, x + 8)) + 'px');
    tip.style.top = '2px';
  } else {
    tip.style.display = 'none';
  }
}

function bindCard(card) {
  state.cards.set(card.dataset.key, { cfg: null, hover: -1 });
  const canvas = card.querySelector('canvas');
  canvas.addEventListener('mousemove', e => {
    const st = state.cards.get(card.dataset.key);
    if (!st || !st.cfg || !st.cfg.available) return;
    const pts = st.cfg.trends.points;
    if (!pts.length) return;
    const r = canvas.getBoundingClientRect();
    const plotW = r.width - 4 - 44;
    const i = Math.round(((e.clientX - r.left) - 4) / plotW * (pts.length - 1));
    st.hover = Math.max(0, Math.min(pts.length - 1, i));
    drawTrend(card);
  });
  canvas.addEventListener('mouseleave', () => {
    const st = state.cards.get(card.dataset.key);
    if (st) st.hover = -1;
    drawTrend(card);
  });
  new ResizeObserver(() => drawTrend(card)).observe(canvas);
}

function renderIndexCard(cfg) {
  const card = $(`.idx-card[data-key="${cfg.key}"]`);
  if (!card) return;
  const old = state.cards.get(cfg.key);
  state.cards.set(cfg.key, { cfg, hover: old ? old.hover : -1 });
  card.classList.toggle('is-error', !cfg.available);
  if (cfg.available) {
    const q = cfg.quote, t = cfg.trends;
    card.querySelector('.idx-price').textContent = fmtNum(q.last, 2);
    const chg = card.querySelector('.idx-chg');
    chg.innerHTML = `<span>${signed(q.change, 2)}</span><span>${pct(q.changePct)}</span>`;
    chg.className = 'idx-chg ' + cls(q.changePct);
    card.querySelector('.idx-extra').textContent =
      `成交额 ${money(q.amount)} · 最高 ${fmtNum(q.high, 2)} · 最低 ${fmtNum(q.low, 2)}`;
    card.querySelector('.idx-time').textContent = (t.date || '—') + ' · 行情 ' + (q.quoteTime || '—').slice(11, 16);
    card.querySelector('.idx-axis').innerHTML = cfg.axis.map(x => `<span>${esc(x)}</span>`).join('');
  } else {
    card.querySelector('.idx-price').textContent = '—';
    card.querySelector('.idx-chg').textContent = '数据源暂不可用';
    card.querySelector('.idx-extra').textContent = esc(cfg.error || '');
  }
  drawTrend(card);
}

async function loadIndices() {
  try {
    const d = await api('/api/indices');
    state.indices = d;
    renderMarket(d.market);
    const first = d.indices.find(x => x.available);
    $('#index-note').textContent =
      `数据源：${d.source} · 行情时点：${first ? (first.quote.quoteTime || '—') : '—'} · ${d.indexNote} · 自动刷新 20 秒` +
      (d.upstreamError ? ` · 上游异常，展示上次缓存：${d.upstreamError}` : '');
    d.indices.forEach(renderIndexCard);
  } catch (e) {
    $('#index-note').textContent = '数据源暂不可用：' + e.message + '（页面不展示模拟数据）';
    $$('.idx-card').forEach(card => {
      state.cards.set(card.dataset.key, { cfg: { available: false, key: card.dataset.key }, hover: -1 });
      drawTrend(card);
    });
  }
}

/* ---------------- 板块排序榜 ---------------- */

function renderRanks() {
  const list = $('#rank-list');
  const d = state.sectors;
  if (!d || !Array.isArray(d.items)) {
    list.innerHTML = '<div class="rank-empty">正在取数…</div>';
    return;
  }
  const items = d.items.filter(x => Number.isFinite(x.score));
  const sorted = items.slice().sort((a, b) => state.order === 'up' ? b.score - a.score : a.score - b.score);
  const top = sorted.slice(0, state.limit);
  $('#rank-rule').textContent = state.order === 'up'
    ? '排序：涨跌幅 × 流通总市值，取数值最大的 10 个板块；最大的在最上、最小的在最下'
    : '排序：涨跌幅 × 流通总市值，取数值最小的 10 个板块（跌最多）；最小的在最上';

  if (!top.length) {
    list.innerHTML = '<div class="rank-empty">当前数据源无可用板块数据</div>';
    return;
  }
  const maxFlow = Math.max(1, ...top.map(x => Math.abs(x.mainNet || 0)));
  state.rowItems.clear();
  list.innerHTML = top.map((x, i) => {
    state.rowItems.set(x.code, x);
    const flowRed = (x.mainNet || 0) >= 0;
    const width = Math.max(2, Math.abs(x.mainNet || 0) / maxFlow * 100);
    const scoreCls = x.score >= 0 ? 'up' : 'down';
    return `<div class="rank-row ${x.score >= 0 ? 'row-up' : 'row-down'}" data-code="${esc(x.code)}">
      <span class="rank-no ${x.score >= 0 ? 'red' : 'blue'}">${i + 1}</span>
      <span class="rk-name"><b>${esc(x.name)}</b><small>${esc(x.code)}</small></span>
      <span class="rk-chg ${cls(x.changePct)}">${pct(x.changePct)}</span>
      <span class="rk-cap">${money(x.floatCap)}</span>
      <span class="rk-score ${scoreCls}">${yi(x.score, true)}<small>亿元</small></span>
      <span class="rk-line"><span class="line-track"><span class="line ${flowRed ? 'red' : 'blue'}" style="width:${width.toFixed(2)}%"></span></span></span>
      <span class="rk-flow ${flowRed ? 'up' : 'blue'}">${yi(x.mainNet, true)}亿</span>
    </div>`;
  }).join('');
  renderSummary(top);
}

function drawDonut(el, segments, palette) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (!total) { el.innerHTML = '<div class="donut-empty">无数据</div>'; return; }
  const R = 42, C = 2 * Math.PI * R, cx = 56, cy = 56;
  let acc = 0, bestLen = 0, bestMid = 0;
  let html = '<svg viewBox="0 0 112 112" width="112" height="112" aria-hidden="true">';
  html += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#f1ece0" stroke-width="16"/>`;
  segments.slice(0, 10).forEach((s, i) => {
    const len = Math.max(0, s.value) / total * C;
    if (len > bestLen) { bestLen = len; bestMid = acc + len / 2; }
    html += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${palette[i % palette.length]}" stroke-width="16" ` +
      `stroke-dasharray="${Math.max(0, len - 1.5).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" ` +
      `transform="rotate(-90 ${cx} ${cy})"><title>${esc(s.name)}：${yi(s.value, false)} 亿</title></circle>`;
    acc += len;
  });
  const ang = (-90 + bestMid / C * 360) * Math.PI / 180;
  const x2 = cx + Math.cos(ang) * 30, y2 = cy + Math.sin(ang) * 30;
  html += `<line x1="${cx}" y1="${cy}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#5b4b8a" stroke-width="2.5" stroke-linecap="round"/>`;
  html += `<circle cx="${cx}" cy="${cy}" r="7" fill="#fff" stroke="#d8c98f" stroke-width="2"/>`;
  html += `<circle cx="${cx}" cy="${cy}" r="3" fill="#c9a55c"/></svg>`;
  el.innerHTML = html;
}

function renderSummary(top) {
  const d = state.sectors;
  const ins = top.filter(x => x.mainNet > 0);
  const outs = top.filter(x => x.mainNet < 0);
  const inSum = ins.reduce((s, x) => s + x.mainNet, 0);
  const outSum = outs.reduce((s, x) => s + Math.abs(x.mainNet), 0);
  const net = top.reduce((s, x) => s + x.mainNet, 0);
  const scoreSum = top.reduce((s, x) => s + x.score, 0);

  drawDonut($('#donut-in'), ins.map(x => ({ name: x.name, value: x.mainNet })), REDS);
  drawDonut($('#donut-out'), outs.map(x => ({ name: x.name, value: Math.abs(x.mainNet) })), BLUES);
  $('#donut-in-center').textContent = ins.length + ' 个板块';
  $('#donut-out-center').textContent = outs.length + ' 个板块';
  $('#sum-in-value').textContent = yi(inSum, true) + ' 亿';
  $('#sum-out-value').textContent = '−' + fmtNum(outSum / 1e8, 2) + ' 亿';
  $('#sum-in-sub').textContent = `占本榜 ${ins.length}/10 · 扇区为各板块净流入占比`;
  $('#sum-out-sub').textContent = `占本榜 ${outs.length}/10 · 扇区为各板块净流出占比`;

  $('#sum-center').innerHTML =
    `<div class="center-big">本榜主力净额合计 <b class="${cls(net)}">${yi(net, true)} 亿</b></div>` +
    `<div class="center-line">排序指标合计（涨跌幅 × 流通市值）：<b class="${cls(scoreSum)}">${yi(scoreSum, true)} 亿</b> · 展示 ${top.length} / ${d.count} 个板块</div>` +
    `<div class="center-line">${esc(d.notes.score)}</div>` +
    `<div class="center-line muted">${esc(d.notes.flow)}</div>` +
    `<div class="center-line muted">${esc(d.notes.overlap)}</div>` +
    `<div class="center-line muted">数据时点 ${esc(d.dataTime || '—')}（北京时间）· 来源 ${esc(d.source)}</div>`;
}

async function loadSectors() {
  try {
    const d = await api('/api/sectors?type=' + state.type);
    state.sectors = d;
    renderMarket(d.market);
    $('#sector-meta').textContent =
      `全市场 ${d.count} 个${d.label}（源 ${d.rawTotal} 条 / 去重后）· 数据时点 ${d.dataTime || '—'}` +
      (d.complete ? '' : ` · 分页取数 ${d.returned}/${d.rawTotal}`) +
      (d.upstreamError ? ` · 上游异常，展示缓存：${d.upstreamError}` : '') + ' · 自动刷新 30 秒';
    $('#footnote').innerHTML =
      `数据来源：${esc(d.source)}；指数来源：${esc(state.indices ? state.indices.source : '东方财富行情接口')}；数据时点：${esc(d.dataTime || '—')}（北京时间，${esc(d.market ? d.market.aShare : '')}）。` +
      `分级行业数值为方向性估算，红涨绿跌；线条与环图的主力净额口径见中部说明。` +
      `<b>免责声明</b>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。`;
    renderRanks();
  } catch (e) {
    $('#sector-meta').textContent = '数据源暂不可用';
    $('#rank-list').innerHTML = `<div class="rank-empty">数据源暂不可用：${esc(e.message)}<br>页面不展示任何模拟或编造数据。</div>`;
    $('#footnote').textContent = '数据源暂不可用，页面不展示模拟数据。';
  }
}

/* ---------------- 悬浮明细 ---------------- */

const tooltip = $('#tooltip');
function positionTooltip(e) {
  const w = tooltip.offsetWidth || 268;
  const h = tooltip.offsetHeight || 220;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
  tooltip.style.left = Math.max(4, x) + 'px';
  tooltip.style.top = Math.max(4, y) + 'px';
}

function bindRankEvents() {
  const list = $('#rank-list');
  list.addEventListener('mouseover', e => {
    const row = e.target.closest('.rank-row');
    if (!row) return;
    const x = state.rowItems.get(row.dataset.code);
    if (!x) return;
    tooltip.innerHTML =
      `<div class="tt-title">${esc(x.name)}<small>${esc(x.code)}</small></div>` +
      `<div class="tt-grid">` +
      `<span>涨跌幅</span><b class="${cls(x.changePct)}">${pct(x.changePct)}</b>` +
      `<span>流通总市值</span><b>${money(x.floatCap)}</b>` +
      `<span>总市值</span><b>${money(x.marketCap)}</b>` +
      `<span>排序指标</span><b>${yi(x.score, true)} 亿</b>` +
      `<span>主力净额</span><b class="${x.mainNet >= 0 ? 'up' : 'blue'}">${yi(x.mainNet, true)} 亿</b>` +
      `<span>主力净占比</span><b>${pct(x.mainPct)}</b>` +
      `<span>超大单净额</span><b>${yi(x.superNet, true)} 亿</b>` +
      `<span>大单净额</span><b>${yi(x.bigNet, true)} 亿</b>` +
      `<span>中单净额</span><b>${yi(x.midNet, true)} 亿</b>` +
      `<span>小单净额</span><b>${yi(x.smallNet, true)} 亿</b>` +
      `<span>成交额</span><b>${money(x.amount)}</b>` +
      `<span>换手率</span><b>${pct(x.turnoverRate)}</b>` +
      `</div>` +
      `<div class="tt-foot">数据时点 ${esc(state.sectors ? state.sectors.dataTime : '—')} · 东方财富板块资金流接口</div>`;
    tooltip.style.display = 'block';
    positionTooltip(e);
  });
  list.addEventListener('mousemove', positionTooltip);
  list.addEventListener('mouseout', e => {
    const to = e.relatedTarget;
    if (!to || typeof to.closest !== 'function' || !to.closest('.rank-row')) tooltip.style.display = 'none';
  });
}

/* ---------------- 交互与启动 ---------------- */

function bindControls() {
  $('#order-switch').addEventListener('click', e => {
    const btn = e.target.closest('button[data-order]');
    if (!btn) return;
    state.order = btn.dataset.order;
    $$('#order-switch button').forEach(b => b.classList.toggle('on', b === btn));
    renderRanks();
  });
  $('#tabs').addEventListener('click', e => {
    const btn = e.target.closest('button[data-type]');
    if (!btn || btn.dataset.type === state.type) return;
    state.type = btn.dataset.type;
    $$('#tabs button').forEach(b => b.classList.toggle('on', b === btn));
    state.sectors = null;
    $('#rank-list').innerHTML = '<div class="rank-empty">正在取数…</div>';
    loadSectors();
  });
  $('#refresh').addEventListener('click', () => { loadIndices(); loadSectors(); });
}

$$('.idx-card').forEach(bindCard);
bindRankEvents();
bindControls();
tickClock();
setInterval(tickClock, 1000);
loadIndices();
loadSectors();
setInterval(() => { if (!document.hidden) loadIndices(); }, 20000);
setInterval(() => { if (!document.hidden) loadSectors(); }, 30000);
