#!/usr/bin/env node
/**
 * Trade Dashboard Local Proxy
 * - CORS 우회용 로컬 프록시 (Node.js 기본 모듈만 사용, npm install 불필요)
 * - 관세청 / Census Bureau / DART / Eurostat API를 로컬에서 호출
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
const { keys, endpoints, port = 8787 } = config;

function fetchExternal(targetUrl) {
  return new Promise((resolve, reject) => {
    const lib = targetUrl.startsWith('https') ? https : http;
    lib.get(targetUrl, { headers: { 'User-Agent': 'TradeDashboard/0.1' } }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
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
  const fp = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  if (!fp.startsWith(__dirname)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    const ext = path.extname(fp).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    };
    send(res, 200, data, types[ext] || 'text/plain');
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const u = new URL(req.url, `http://localhost:${port}`);
  const q = Object.fromEntries(u.searchParams);

  try {
    let target;

    if (u.pathname === '/api/health') {
      return send(res, 200, JSON.stringify({
        ok: true,
        keys: {
          kcs: !!keys.kcs,
          census: !!keys.census,
          dart: !!keys.dart,
        }
      }));
    }

    // 관세청 품목별 (HS 코드별) 수출입실적
    if (u.pathname === '/api/kcs/item') {
      const params = new URLSearchParams({
        serviceKey: keys.kcs,
        strtYymm: q.strtYymm || '202501',
        endYymm: q.endYymm || '202612',
        hsSgn: q.hsSgn || '854232',
        numOfRows: q.numOfRows || '100',
        pageNo: q.pageNo || '1',
      });
      target = `${endpoints.kcsItem}?${params}`;
    }
    // 관세청 국가별 수출입실적
    else if (u.pathname === '/api/kcs/country') {
      const params = new URLSearchParams({
        serviceKey: keys.kcs,
        strtYymm: q.strtYymm || '202501',
        endYymm: q.endYymm || '202612',
        numOfRows: q.numOfRows || '200',
        pageNo: q.pageNo || '1',
      });
      if (q.cntyCd) params.append('cntyCd', q.cntyCd);
      target = `${endpoints.kcsCountry}?${params}`;
    }
    // Census Bureau — monthly US imports by HS
    else if (u.pathname === '/api/census/imports') {
      const params = new URLSearchParams({
        get: q.get || 'GEN_VAL_MO,CTY_CODE,CTY_NAME,I_COMMODITY',
        time: q.time || 'from 2024-01',
        I_COMMODITY: q.hs || '854232',
        key: keys.census,
      });
      target = `${endpoints.census}?${params}`;
    }
    // DART — 기업 공시 목록 / 재무제표 등
    else if (u.pathname === '/api/dart/list') {
      const params = new URLSearchParams({
        crtfc_key: keys.dart,
        corp_code: q.corp_code || '',
        bgn_de: q.bgn_de || '20240101',
        end_de: q.end_de || '20261231',
        page_count: '100',
      });
      if (q.pblntf_ty) params.append('pblntf_ty', q.pblntf_ty);
      target = `${endpoints.dart}?${params}`;
    }
    else if (u.pathname === '/api/dart/financial') {
      const params = new URLSearchParams({
        crtfc_key: keys.dart,
        corp_code: q.corp_code || '',
        bsns_year: q.bsns_year || '2025',
        reprt_code: q.reprt_code || '11011',
        fs_div: 'CFS',
      });
      target = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?${params}`;
    }
    // Eurostat — 키 불필요, 단순 프록시
    else if (u.pathname === '/api/eurostat') {
      const dataset = q.dataset || 'DS-059668';
      const params = new URLSearchParams(q);
      params.delete('dataset');
      target = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${dataset}?${params}`;
    }
    // Static file fallback
    else if (!u.pathname.startsWith('/api/')) {
      return serveStatic(req, res);
    }
    else {
      return send(res, 404, JSON.stringify({ error: 'unknown route' }));
    }

    console.log(`→ ${u.pathname}  ${target.replace(/serviceKey=[^&]+/, 'serviceKey=***').replace(/key=[^&]+/, 'key=***').replace(/crtfc_key=[^&]+/, 'crtfc_key=***').slice(0, 200)}`);
    const result = await fetchExternal(target);
    const ct = result.headers['content-type'] || 'application/json';
    send(res, result.status, result.body, ct);
  } catch (err) {
    console.error('✗ proxy error:', err.message);
    send(res, 500, JSON.stringify({ error: err.message }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`\n🌐 Trade Dashboard Proxy`);
  console.log(`   http://localhost:${port}/`);
  console.log(`   대시보드: http://localhost:${port}/index.html`);
  console.log(`   헬스체크: http://localhost:${port}/api/health\n`);
  console.log(`   Ctrl+C 로 종료\n`);
});
