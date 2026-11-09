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

const TREND_PAD_L = 36, TREND_PAD_R = 42;

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
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(cfg && !cfg.available ? '数据源暂不可用' : '正在加载分时数据…', w / 2, h / 2);
    tip.style.display = 'none';
    return;
  }

  const padL = TREND_PAD_L, padR = TREND_PAD_R, padT = 4, padB = 2;
  const plotW = Math.max(20, w - padL - padR);
  const priceH = (h - padT - padB) * 0.66;
  const volTop = padT + priceH + 4;
  const volH = Math.max(6, h - padB - volTop);
  const q = cfg.quote || {};
  const pre = cfg.trends.preClose || q.prevClose || pts[0].price;
  // 横轴按全天交易分钟铺展：盘中曲线只画到当前，右侧留白为剩余时段
  const totalMinutes = Math.max(pts.length, cfg.trends.minutes || pts.length);
  const xOf = i => padL + (totalMinutes <= 1 ? 0 : i / (totalMinutes - 1) * plotW);

  let dev = 0;
  for (const p of pts) {
    dev = Math.max(dev, Math.abs(p.price - pre));
    if (p.avg) dev = Math.max(dev, Math.abs(p.avg - pre));
  }
  dev = dev * 1.15 || pre * 0.005;
  const yTop = pre + dev, yBot = pre - dev;
  const yOf = v => padT + (yTop - v) / (yTop - yBot) * priceH;
  const color = (q.changePct || 0) >= 0 ? UP : DOWN;

  // 水平网格 + 左价格轴 / 右涨跌幅轴（5 档，中档为昨收 0% 基准）
  ctx.lineWidth = 1;
  ctx.font = '10px "Segoe UI", sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = padT + i * priceH / 4;
    const isBase = i === 2;
    ctx.strokeStyle = isBase ? '#c9b98f' : '#ece5d7';
    ctx.setLineDash(isBase ? [4, 3] : []);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    const pv = yTop - i * (yTop - yBot) / 4;
    const cp = (pv - pre) / pre * 100;
    ctx.fillStyle = '#a3a8b1'; ctx.textAlign = 'right';
    ctx.fillText(fmtNum(pv, 0), padL - 3, y + 3);
    ctx.textAlign = 'left';
    ctx.fillStyle = cp > 0.005 ? hexA(UP, 0.9) : cp < -0.005 ? hexA(DOWN, 0.9) : '#9a9fa8';
    ctx.fillText((cp > 0.005 ? '+' : cp < -0.005 ? '−' : '') + Math.abs(cp).toFixed(2) + '%', padL + plotW + 3, y + 3);
  }
  ctx.setLineDash([]);

  // 垂直网格（全天 4 等分）
  for (let i = 0; i <= 4; i++) {
    const x = padL + i * plotW / 4;
    ctx.strokeStyle = '#f1ece1';
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, volTop + volH); ctx.stroke();
  }

  // 价格面积 + 价格线
  const grad = ctx.createLinearGradient(0, padT, 0, padT + priceH);
  grad.addColorStop(0, hexA(color, 0.18));
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

  // 均价线
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

  // 独立成交量区：分隔线 + 每分钟量柱（红涨绿跌）+ 峰值刻度
  const maxV = Math.max(1, ...pts.map(p => p.volume || 0));
  ctx.strokeStyle = '#e5ddcc';
  ctx.beginPath(); ctx.moveTo(padL, volTop - 2); ctx.lineTo(padL + plotW, volTop - 2); ctx.stroke();
  const bw = Math.max(1, Math.min(4, plotW / Math.max(1, totalMinutes) * 0.7));
  pts.forEach((p, i) => {
    const bh = Math.min(volH, (p.volume || 0) / maxV * volH);
    const rising = i === 0 ? p.price >= pre : p.price >= pts[i - 1].price;
    ctx.fillStyle = hexA(rising ? UP : DOWN, 0.58);
    ctx.fillRect(xOf(i) - bw / 2, volTop + volH - bh, bw, bh);
  });
  ctx.font = '9px "Segoe UI", sans-serif';
  ctx.fillStyle = '#b3b8c0';
  ctx.textAlign = 'right';
  ctx.fillText(fmtNum(maxV / 1e4, 0) + '万', padL - 3, volTop + 8);
  ctx.textAlign = 'left';
  ctx.fillText(fmtNum(maxV / 1e4, 0) + '万', padL + plotW + 3, volTop + 8);

  // 盘中实时末端点：外圈光晕 + 实心点（末端价由实时报价驱动）
  if (cfg.trends.livePoint && pts.length) {
    const x = xOf(pts.length - 1), y = yOf(pts[pts.length - 1].price);
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = hexA(color, 0.16); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();
  }

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
    tip.innerHTML = `<b>${esc(p.time)}${p.live ? ' · 实时' : ''}</b> 价 ${fmtNum(p.price, 2)} · ${signed(cp, 2)}%<br>分时量 ${fmtNum(p.volume / 1e4, 0)}万手` +
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
    const plotW = r.width - TREND_PAD_L - TREND_PAD_R;
    const total = Math.max(pts.length, (st.cfg.trends && st.cfg.trends.minutes) || pts.length);
    const i = Math.round(((e.clientX - r.left) - TREND_PAD_L) / plotW * (total - 1));
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
  card.classList.toggle('is-live', !!(cfg.available && cfg.trends && cfg.trends.isLive));
  if (cfg.available) {
    const q = cfg.quote, t = cfg.trends;
    card.querySelector('.idx-price').textContent = fmtNum(q.last, 2);
    const chg = card.querySelector('.idx-chg');
    chg.innerHTML = `<span>${signed(q.change, 2)}</span><span>${pct(q.changePct)}</span>`;
    chg.className = 'idx-chg ' + cls(q.changePct);
    card.querySelector('.idx-extra').textContent =
      `成交额 ${money(q.amount)} · 最高 ${fmtNum(q.high, 2)} · 最低 ${fmtNum(q.low, 2)}`;
    card.querySelector('.idx-time').textContent =
      (t.date || '—') + ' · ' + (q.quoteTime || '—').slice(11, 19) + (t.isLive ? ' · 实时' : '');
    card.querySelector('.idx-axis').innerHTML = cfg.axis.map(x => `<span>${esc(x)}</span>`).join('');
  } else {
    card.querySelector('.idx-price').textContent = '—';
    card.querySelector('.idx-chg').textContent = '数据源暂不可用';
    card.querySelector('.idx-extra').textContent = esc(cfg.error || '');
  }
  drawTrend(card);
}

async function loadIndices(force) {
  try {
    const d = await api('/api/indices' + (force ? '?force=1' : ''));
    state.indices = d;
    renderMarket(d.market);
    applyRefreshSchedule(d.market);
    const first = d.indices.find(x => x.available);
    $('#index-note').textContent =
      `数据源：${d.source} · 行情时点：${first ? (first.quote.quoteTime || '—') : '—'} · ${d.indexNote} · 自动刷新 ${refreshLabel(d.market, 'indices')}` +
      (d.upstreamError ? ` · 上游异常，展示上次缓存：${d.upstreamError}` : '');
    d.indices.forEach(renderIndexCard);
    return { ok: !d.upstreamError, error: d.upstreamError || '' };
  } catch (e) {
    $('#index-note').textContent = '数据源暂不可用：' + e.message + '（页面不展示模拟数据）';
    $$('.idx-card').forEach(card => {
      state.cards.set(card.dataset.key, { cfg: { available: false, key: card.dataset.key }, hover: -1 });
      drawTrend(card);
    });
    if (refreshPhase === null) applyRefreshSchedule(null);
    return { ok: false, error: e.message };
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
}

/* 底部环图：数据来自全市场资金流前十 / 后十，与中部榜单完全解耦 */
const DONUT_R = 42, DONUT_W = 16, DONUT_C = 2 * Math.PI * DONUT_R;

// 内径 r-w/2 = 34 保持不变，外径由 50 扩到 56；弧长按半径比例缩放以维持扇区角度
function animateDonutSeg(seg, expand) {
  if (!seg || typeof seg.getAttribute !== 'function') return;
  if (seg._raf) cancelAnimationFrame(seg._raf);
  const fromR = Number(seg.getAttribute('r')) || DONUT_R;
  const fromW = Number(seg.getAttribute('stroke-width')) || DONUT_W;
  const toR = expand ? 45 : DONUT_R;
  const toW = expand ? 22 : DONUT_W;
  const len = Number(seg.dataset.len) || 0;
  const acc = Number(seg.dataset.acc) || 0;
  const t0 = performance.now(), dur = 180;
  const step = now => {
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    const r = fromR + (toR - fromR) * e;
    const w = fromW + (toW - fromW) * e;
    const k = r / DONUT_R;
    seg.setAttribute('r', r.toFixed(2));
    seg.setAttribute('stroke-width', w.toFixed(2));
    seg.setAttribute('stroke-dasharray', Math.max(0, len * k - 1.5).toFixed(2) + ' ' + (DONUT_C * k).toFixed(2));
    seg.setAttribute('stroke-dashoffset', (-acc * k).toFixed(2));
    seg._raf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  seg._raf = requestAnimationFrame(step);
}

function drawDonut(el, segments, palette, pop) {
  if (!el) return;
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (!total || !segments.length) {
    el.innerHTML = '<div class="donut-empty">无数据</div>';
    if (pop) pop.className = 'donut-pop';
    return;
  }
  const cx = 56, cy = 56;
  let acc = 0;
  let html = '<svg viewBox="0 0 112 112" width="112" height="112" aria-hidden="true">';
  html += `<circle cx="${cx}" cy="${cy}" r="${DONUT_R}" fill="none" stroke="#f1ece0" stroke-width="${DONUT_W}" pointer-events="none"/>`;
  segments.slice(0, 10).forEach((s, i) => {
    const len = Math.max(0, s.value) / total * DONUT_C;
    html += `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${DONUT_R}" fill="none" ` +
      `stroke="${palette[i % palette.length]}" stroke-width="${DONUT_W}" ` +
      `stroke-dasharray="${Math.max(0, len - 1.5).toFixed(2)} ${DONUT_C.toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" ` +
      `data-name="${esc(s.name)}" data-value="${yi(s.value, false)}" data-len="${len.toFixed(3)}" data-acc="${acc.toFixed(3)}" ` +
      `transform="rotate(-90 ${cx} ${cy})"></circle>`;
    acc += len;
  });
  html += `<circle cx="${cx}" cy="${cy}" r="3" fill="#c9a55c" pointer-events="none"/></svg>`;
  el.innerHTML = html;
  el._active = null;

  // 事件只绑定一次，避免每次重绘累积监听
  if (el._donutBound) return;
  el._donutBound = true;
  const center = el.parentNode && el.parentNode.querySelector ? el.parentNode.querySelector('.donut-center') : null;
  const hidePop = () => {
    if (el._active) { animateDonutSeg(el._active, false); el._active = null; }
    if (pop) pop.className = 'donut-pop';
    if (center) center.style.opacity = '';
  };
  el.addEventListener('mouseover', e => {
    const seg = e.target && e.target.closest ? e.target.closest('.donut-seg') : null;
    if (!seg) return;
    if (el._active && el._active !== seg) animateDonutSeg(el._active, false);
    el._active = seg;
    animateDonutSeg(seg, true);
    if (pop) {
      const isIn = pop.dataset.kind === 'in';
      pop.innerHTML = `<b>${esc(seg.dataset.name)}</b><span class="pop-amt ${isIn ? 'up' : 'blue'}">` +
        `${isIn ? '+' : '−'}${esc(seg.dataset.value)} 亿</span>`;
      pop.className = 'donut-pop show';
    }
    if (center) center.style.opacity = '0';
  });
  el.addEventListener('mouseout', e => {
    const seg = e.target && e.target.closest ? e.target.closest('.donut-seg') : null;
    if (!seg) return;
    const to = e.relatedTarget;
    if (to && typeof to.closest === 'function' && to.closest('.donut-seg')) return;
    hidePop();
  });
  el.addEventListener('mouseleave', hidePop);
}

// 汇总数据只看全市场资金流：净流入前十 / 净流出前十，与中部榜单（按涨跌幅×流通市值排序）无关
function renderSummary(d) {
  const notes = (d && d.notes) || { flow: '', overlap: '', score: '' };
  const items = (d && Array.isArray(d.items)) ? d.items.filter(x => Number.isFinite(x.mainNet)) : [];
  const inflow = items.filter(x => x.mainNet > 0).slice().sort((a, b) => b.mainNet - a.mainNet).slice(0, 10);
  const outflow = items.filter(x => x.mainNet < 0).slice().sort((a, b) => a.mainNet - b.mainNet).slice(0, 10);
  const inSum = inflow.reduce((s, x) => s + x.mainNet, 0);
  const outSum = outflow.reduce((s, x) => s + Math.abs(x.mainNet), 0);
  const net = inSum - outSum;

  drawDonut($('#donut-in'), inflow.map(x => ({ name: x.name, value: x.mainNet })), REDS, $('#donut-in-pop'));
  drawDonut($('#donut-out'), outflow.map(x => ({ name: x.name, value: Math.abs(x.mainNet) })), BLUES, $('#donut-out-pop'));
  $('#donut-in-center').textContent = '流入前十';
  $('#donut-out-center').textContent = '流出前十';
  $('#sum-in-value').textContent = yi(inSum, true) + ' 亿';
  $('#sum-out-value').textContent = '−' + fmtNum(outSum / 1e8, 2) + ' 亿';
  $('#sum-in-sub').textContent = `全市场 ${items.length} 个板块 · 净流入前 ${inflow.length} 位，扇区为净流入占比`;
  $('#sum-out-sub').textContent = `全市场 ${items.length} 个板块 · 净流出前 ${outflow.length} 位，扇区为净流出占比`;

  $('#sum-center').innerHTML =
    `<div class="center-big">今日盘口净额（前十对前十） <b class="${cls(net)}">${yi(net, true)} 亿</b></div>` +
    `<div class="center-line">流入前十合计 <b class="up">+${fmtNum(inSum / 1e8, 2)} 亿</b> · 流出前十合计 <b class="blue">−${fmtNum(outSum / 1e8, 2)} 亿</b></div>` +
    `<div class="center-line">${esc(notes.flow)}</div>` +
    `<div class="center-line muted">${esc(notes.overlap)}</div>` +
    `<div class="center-line muted">数据时点 ${esc(d && d.dataTime ? d.dataTime : '—')}（北京时间）· 来源 ${esc(d && d.source ? d.source : '—')}</div>`;
}

async function loadSectors(force) {
  try {
    const d = await api('/api/sectors?type=' + state.type + (force ? '&force=1' : ''));
    state.sectors = d;
    renderMarket(d.market);
    applyRefreshSchedule(d.market);
    $('#sector-meta').textContent =
      `全市场 ${d.count} 个${d.label}（源 ${d.rawTotal} 条 / 去重后）· 数据时点 ${d.dataTime || '—'}` +
      (d.complete ? '' : ` · 分页取数 ${d.returned}/${d.rawTotal}`) +
      (d.upstreamError ? ` · 上游异常，展示缓存：${d.upstreamError}` : '') + ` · 自动刷新 ${refreshLabel(d.market, 'sectors')}`;
    $('#footnote').innerHTML =
      `数据来源：${esc(d.source)} / ${esc(state.indices ? state.indices.source : '东方财富行情接口')}；数据时点 ${esc(d.dataTime || '—')}（北京时间，${esc(d.market ? d.market.aShare : '')}）；口径说明见中部与底部。` +
      `<b>免责声明</b>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。`;
    renderRanks();
    renderSummary(d);
    return { ok: !d.upstreamError, error: d.upstreamError || '' };
  } catch (e) {
    $('#sector-meta').textContent = '数据源暂不可用';
    $('#rank-list').innerHTML = `<div class="rank-empty">数据源暂不可用：${esc(e.message)}<br>页面不展示任何模拟或编造数据。</div>`;
    $('#footnote').textContent = '数据源暂不可用，页面不展示模拟数据。';
    if (refreshPhase === null) applyRefreshSchedule(null);
    return { ok: false, error: e.message };
  }
}

/* ---------------- 悬浮明细 ---------------- */

const tooltip = $('#tooltip');
function positionTooltip(e) {
  const w = tooltip.offsetWidth || 288;
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

/* ---------------- 自动刷新调度 + 手动刷新状态提示 ---------------- */

const REFRESH_CFG = {
  live:   { indices: 1000,   sectors: 5000 },   // 盘中：指数 1s / 板块 5s
  closed: { indices: 120000, sectors: 120000 }  // 休盘：一律 120s
};
const refreshTimers = { indices: null, sectors: null };
const refreshBusy = { indices: false, sectors: false };
let refreshPhase = null;

function refreshLabel(market, kind) {
  const phase = market && market.trading ? 'live' : 'closed';
  const ms = REFRESH_CFG[phase][kind];
  return ms >= 1000 ? (ms / 1000) + ' 秒' : ms + ' 毫秒';
}

function applyRefreshSchedule(market) {
  const phase = market && market.trading ? 'live' : 'closed';
  if (phase === refreshPhase) return;   // 状态没变就不重建定时器
  refreshPhase = phase;
  const cfg = REFRESH_CFG[phase];
  clearInterval(refreshTimers.indices);
  clearInterval(refreshTimers.sectors);
  refreshTimers.indices = setInterval(() => {
    if (document.hidden || refreshBusy.indices) return;
    refreshBusy.indices = true;
    loadIndices().finally(() => { refreshBusy.indices = false; });
  }, cfg.indices);
  refreshTimers.sectors = setInterval(() => {
    if (document.hidden || refreshBusy.sectors) return;
    refreshBusy.sectors = true;
    loadSectors().finally(() => { refreshBusy.sectors = false; });
  }, cfg.sectors);
}

// /api/health 不请求上游，用它轻量检测盘中/休盘切换，避免 120s 定时器拖到开盘后才生效
async function syncPhase() {
  try {
    const h = await api('/api/health');
    const phase = h.market && h.market.trading ? 'live' : 'closed';
    if (phase === refreshPhase) return;
    applyRefreshSchedule(h.market);
    if (!document.hidden) { loadIndices(); loadSectors(); }
  } catch { /* 健康检查失败时保持当前调度 */ }
}

const refreshToast = $('#refresh-toast');
let refreshToastTimer = null;
function showRefreshToast(ok, reason) {
  clearTimeout(refreshToastTimer);
  const text = ok ? '刷新成功' : '刷新失败：' + (reason || '数据源暂不可用');
  refreshToast.textContent = text;
  refreshToast.title = text;   // 原因较长时鼠标悬停可看全文
  refreshToast.className = 'refresh-toast show ' + (ok ? 'ok' : 'fail');
  refreshToastTimer = setTimeout(() => {
    refreshToast.className = 'refresh-toast';
    refreshToast.textContent = '';
  }, 1500);
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
  $('#refresh').addEventListener('click', async () => {
    const btn = $('#refresh');
    btn.disabled = true;
    try {
      // force=1 绕过后端缓存；两路都成功才算成功，任一失败显示具体原因
      const rs = await Promise.all([loadIndices(true), loadSectors(true)]);
      const errors = rs.filter(r => !r || !r.ok).map(r => (r && r.error) || '数据源暂不可用');
      if (errors.length) showRefreshToast(false, Array.from(new Set(errors)).join('；'));
      else showRefreshToast(true);
    } finally {
      btn.disabled = false;
    }
  });
}

$$('.idx-card').forEach(bindCard);
bindRankEvents();
bindControls();
tickClock();
setInterval(tickClock, 1000);
loadIndices();       // 首次成功后由 applyRefreshSchedule 按盘中/休盘设定定时器
loadSectors();
setInterval(syncPhase, 10000);   // 每 10s 轻量检测交易状态切换
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // 标签页恢复可见时立即补刷一次，不等下一个定时器
  if (!refreshBusy.indices) {
    refreshBusy.indices = true;
    loadIndices().finally(() => { refreshBusy.indices = false; });
  }
  if (!refreshBusy.sectors) {
    refreshBusy.sectors = true;
    loadSectors().finally(() => { refreshBusy.sectors = false; });
  }
});
