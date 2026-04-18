#!/usr/bin/env node
/**
 * Trade Dashboard Local Proxy v0.3
 * - 관세청 + Census Bureau 만 실데이터 집계 (DART 기업 실적 제거)
 * - /api/bulk/init : 한 번 호출로 모든 무역 데이터 수집, 6시간 캐시
 * - Node.js 기본 모듈만 사용 (npm install 불필요)
 * - 실행: node proxy.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('✗ config.json 없음. config.example.json 복사해서 키 입력 후 실행하세요.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { keys, port = 8787 } = config;

// ────────────────────────────────────────────────────────────
// 추적 대상 HS 코드
// ────────────────────────────────────────────────────────────
const HS_CODES = [
  { hs: '854232', label: '메모리반도체 (DRAM/NAND)', sector: '반도체'   },
  { hs: '330499', label: '스킨케어 화장품',          sector: '화장품'   },
  { hs: '190230', label: '라면(인스턴트 국수)',       sector: '음식료'   },
  { hs: '850423', label: '대형 전력 변압기',         sector: '전력기기' },
  { hs: '870380', label: '전기자동차',               sector: '자동차'   },
];

// ────────────────────────────────────────────────────────────
// 유틸리티
// ────────────────────────────────────────────────────────────

function fetchExternal(targetUrl, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const lib = targetUrl.startsWith('https') ? https : http;
    const req = lib.get(targetUrl, {
      headers: { 'User-Agent': 'TradeDashboard/0.3' },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve({ status: res.statusCode, headers: res.headers, body: '', redirected: res.headers.location });
      }
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout ${targetUrl.slice(0,80)}`)); });
  });
}

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function serveStatic(req, res) {
  const fp = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!fp.startsWith(__dirname)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    const ext = path.extname(fp).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    };
    send(res, 200, data, types[ext] || 'text/plain');
  });
}

// 아주 단순한 XML → 객체 파서 (관세청 응답 전용)
function parseXmlItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const obj = {};
    const fieldRegex = /<(\w+)>([^<]*)<\/\1>/g;
    let f;
    while ((f = fieldRegex.exec(m[1])) !== null) {
      obj[f[1]] = f[2].trim();
    }
    items.push(obj);
  }
  return items;
}

function parseXmlResultCode(xml) {
  const m = xml.match(/<resultCode>([^<]+)<\/resultCode>/);
  return m ? m[1] : null;
}

function parseXmlResultMsg(xml) {
  const m = xml.match(/<resultMsg>([^<]+)<\/resultMsg>/);
  return m ? m[1] : null;
}

// ────────────────────────────────────────────────────────────
// 관세청 (KCS) — HS 코드별 월별 수출입
//   * 1년 이내만 허용이므로 연도별로 chunk 호출
// ────────────────────────────────────────────────────────────

async function fetchKcsItemYear(hsSgn, yyyy) {
  const allItems = [];
  let page = 1;
  while (page < 10) {
    const params = new URLSearchParams({
      serviceKey: keys.kcs,
      strtYymm: `${yyyy}01`,
      endYymm:  `${yyyy}12`,
      hsSgn,
      numOfRows: '1000',
      pageNo: String(page),
    });
    const url = `https://apis.data.go.kr/1220000/Itemtrade/getItemtradeList?${params}`;
    const r = await fetchExternal(url);
    if (r.status !== 200) break;
    const rc = parseXmlResultCode(r.body);
    if (rc !== '00') {
      console.log(`  [kcs] ${hsSgn} ${yyyy} resultCode=${rc} msg=${parseXmlResultMsg(r.body)}`);
      break;
    }
    const items = parseXmlItems(r.body);
    if (items.length === 0) break;
    allItems.push(...items);
    if (items.length < 1000) break;
    page++;
  }
  return allItems;
}

async function fetchKcsItem(hsSgn, fromYear, toYear) {
  const all = [];
  for (let y = fromYear; y <= toYear; y++) {
    const rows = await fetchKcsItemYear(hsSgn, y);
    all.push(...rows);
  }
  // 월별 집계 (YYYY-MM). HS 10자리 상세들의 합.
  // "총계" 같은 비-월별 행은 제외.
  const byMonth = {};
  for (const it of all) {
    const raw = it.year || '';
    if (!/^\d{4}\.\d{2}$/.test(raw)) continue;
    const ym = raw.replace('.', '-');
    if (!byMonth[ym]) byMonth[ym] = { exp: 0, imp: 0, bal: 0, expWgt: 0, impWgt: 0 };
    byMonth[ym].exp    += Number(it.expDlr || 0);
    byMonth[ym].imp    += Number(it.impDlr || 0);
    byMonth[ym].bal    += Number(it.balPayments || 0);
    byMonth[ym].expWgt += Number(it.expWgt || 0);
    byMonth[ym].impWgt += Number(it.impWgt || 0);
  }
  const months = Object.keys(byMonth).sort();
  return {
    months,
    exp:    months.map(m => byMonth[m].exp),
    imp:    months.map(m => byMonth[m].imp),
    bal:    months.map(m => byMonth[m].bal),
    expWgt: months.map(m => byMonth[m].expWgt),
    impWgt: months.map(m => byMonth[m].impWgt),
  };
}

// ────────────────────────────────────────────────────────────
// Census Bureau — 미국 HS 코드별 월별 수입
// ────────────────────────────────────────────────────────────

async function fetchCensus(hs, fromYear = 2023) {
  const params = new URLSearchParams({
    get: 'GEN_VAL_MO,CTY_NAME,I_COMMODITY',
    time: `from ${fromYear}-01`,
    I_COMMODITY: hs,
    key: keys.census,
  });
  const url = `https://api.census.gov/data/timeseries/intltrade/imports/hs?${params}`;
  const r = await fetchExternal(url);
  if (r.redirected || r.status !== 200) return { error: `census status ${r.status}`, months: [], values: [] };
  let rows;
  try { rows = JSON.parse(r.body); } catch (e) { return { error: 'parse', months: [], values: [] }; }
  if (!Array.isArray(rows) || rows.length < 2) return { months: [], values: [] };
  const idxVal  = rows[0].indexOf('GEN_VAL_MO');
  const idxCty  = rows[0].indexOf('CTY_NAME');
  const idxTime = rows[0].indexOf('time');
  const byMonth = {};
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][idxCty] !== 'TOTAL FOR ALL COUNTRIES') continue;
    byMonth[rows[i][idxTime]] = Number(rows[i][idxVal]);
  }
  const months = Object.keys(byMonth).sort();
  return {
    months,
    values: months.map(m => byMonth[m]),
  };
}

// ────────────────────────────────────────────────────────────
// Bulk 집계 (6시간 메모리 캐시)
// ────────────────────────────────────────────────────────────

let BULK_CACHE = { ts: 0, data: null };
const BULK_TTL = 6 * 60 * 60 * 1000;

async function buildBulk() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const fromYear = 2023;

  console.log(`[bulk] ${fromYear} ~ ${yyyy}, HS ${HS_CODES.length}개`);

  const result = {
    generated_at: new Date().toISOString(),
    period: { fromYear, toYear: yyyy },
    kr: { hs: {} },
    us: { hs: {} },
    errors: [],
  };

  // 관세청 — HS 코드별 월별 (순차, 레이트 리밋 고려)
  for (const { hs, label, sector } of HS_CODES) {
    try {
      console.log(`  [kcs] ${hs} ${label}`);
      const d = await fetchKcsItem(hs, fromYear, yyyy);
      result.kr.hs[hs] = { hs, label, sector, ...d };
    } catch (e) {
      result.errors.push({ src: 'kcs', hs, msg: e.message });
      result.kr.hs[hs] = { hs, label, sector, months: [], exp: [], imp: [], bal: [], error: e.message };
    }
  }

  // Census — HS 코드별 월별 미국 수입 (병렬)
  await Promise.all(HS_CODES.map(async ({ hs, label, sector }) => {
    try {
      console.log(`  [census] ${hs} ${label}`);
      const d = await fetchCensus(hs, fromYear);
      result.us.hs[hs] = { hs, label, sector, ...d };
    } catch (e) {
      result.errors.push({ src: 'census', hs, msg: e.message });
      result.us.hs[hs] = { hs, label, sector, months: [], values: [], error: e.message };
    }
  }));

  return result;
}

async function getBulk(force = false) {
  if (!force && BULK_CACHE.data && (Date.now() - BULK_CACHE.ts) < BULK_TTL) {
    return { ...BULK_CACHE.data, cached: true, cache_age_ms: Date.now() - BULK_CACHE.ts };
  }
  const data = await buildBulk();
  BULK_CACHE = { ts: Date.now(), data };
  return { ...data, cached: false };
}

// ────────────────────────────────────────────────────────────
// HTTP 서버
// ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const u = new URL(req.url, `http://localhost:${port}`);
  const q = Object.fromEntries(u.searchParams);

  try {
    if (u.pathname === '/api/health') {
      return send(res, 200, JSON.stringify({
        ok: true,
        version: '0.3',
        keys: { kcs: !!keys.kcs, census: !!keys.census },
        bulk_cached: !!BULK_CACHE.data,
        cache_age_sec: BULK_CACHE.data ? Math.round((Date.now() - BULK_CACHE.ts)/1000) : null,
      }));
    }

    if (u.pathname === '/api/bulk/init') {
      const force = q.force === '1';
      const data = await getBulk(force);
      return send(res, 200, JSON.stringify(data));
    }

    if (u.pathname === '/api/kcs/item') {
      const d = await fetchKcsItem(
        q.hsSgn || '854232',
        Number(q.fromYear || 2024),
        Number(q.toYear || new Date().getFullYear()),
      );
      return send(res, 200, JSON.stringify(d));
    }
    if (u.pathname === '/api/census/imports') {
      const d = await fetchCensus(q.hs || '854232', Number(q.fromYear || 2024));
      return send(res, 200, JSON.stringify(d));
    }

    if (!u.pathname.startsWith('/api/')) return serveStatic(req, res);
    return send(res, 404, JSON.stringify({ error: 'unknown route' }));
  } catch (err) {
    console.error('✗ proxy error:', err.message);
    send(res, 500, JSON.stringify({ error: err.message }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`\n🌐 Trade Dashboard Proxy v0.3`);
  console.log(`   http://localhost:${port}/`);
  console.log(`   대시보드:   http://localhost:${port}/index.html`);
  console.log(`   헬스체크:   http://localhost:${port}/api/health`);
  console.log(`   전체 동기화: http://localhost:${port}/api/bulk/init`);
  console.log(`   강제 갱신:   http://localhost:${port}/api/bulk/init?force=1`);
  console.log(`\n   Ctrl+C 로 종료\n`);
});
