'use strict';
// Standalone test: node probe.js <dongle-ip> <dongle-SN>
// Verifies the local API works and prints decoded values before you install the plugin.

const http = require('http');

const host = process.argv[2];
const sn = process.argv[3] || '';
if (!host) {
  console.error('Usage: node probe.js <dongle-ip> <dongle-SN>');
  process.exit(1);
}

const body = 'optType=ReadRealTimeData' + (sn ? '&pwd=' + sn : '');
const req = http.request(
  {
    host, port: 80, path: '/', method: 'POST', timeout: 8000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'X-Forwarded-For': '5.8.8.8',
    },
  },
  (res) => {
    let raw = '';
    res.on('data', (c) => (raw += c));
    res.on('end', () => {
      try {
        const j = JSON.parse(raw);
        const d = (i) => (typeof j.Data[i] === 'number' ? j.Data[i] : 0);
        const s16 = (v) => (v > 0x7fff ? v - 0x10000 : v);
        const p32 = (lo, hi) => { let v = (hi * 65536) + lo; return v >= 0x80000000 ? v - 0x100000000 : v; };
        console.log('Type:', j.type, ' SN:', j.SN, ' Ver:', j.ver);
        console.log('Data length:', Array.isArray(j.Data) ? j.Data.length : 'N/A');
        console.log('--- Decoded (X3 Hybrid G4) ---');
        console.log('PV power   :', d(14) + d(15), 'W  (PV1', d(14), '/ PV2', d(15), ')');
        console.log('Grid power :', p32(d(34), d(35)), 'W  (+ export / - import)');
        console.log('Battery    :', s16(d(41)), 'W  (+ charge / - discharge)');
        console.log('Load       :', s16(d(47)), 'W');
        console.log('SOC        :', d(103), '%');
        console.log('Yield today:', d(70) / 10, 'kWh');
        console.log('Yield total:', p32(d(68), d(69)) / 10, 'kWh');
        console.log('\nFull raw Data[]:\n', JSON.stringify(j.Data));
      } catch (e) {
        console.error('Failed to parse:', e.message);
        console.error('Raw:', raw.slice(0, 300));
      }
    });
  }
);
req.on('timeout', () => { console.error('Timeout — check IP / that local API is enabled.'); req.destroy(); });
req.on('error', (e) => console.error('Error:', e.message));
req.write(body);
req.end();
