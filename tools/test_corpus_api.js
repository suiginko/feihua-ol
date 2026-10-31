'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, text: data });
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('1. 正在启动测试服务端 (PORT=' + PORT + ')...');
  const child = spawn(process.execPath, [
    '--max-old-space-size=640',
    path.join(ROOT, 'server.js')
  ], {
    env: { ...process.env, PORT: String(PORT), SHUTDOWN_HOOK: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stderr.on('data', d => process.stderr.write(d));

  // 等待服务监听
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await get('/api/stats');
      if (res.status === 200) {
        console.log('   服务端就绪');
        break;
      }
    } catch (_) {}
  }

  let bad = 0;
  try {
    console.log('2. 测试 /api/corpus/summary ...');
    const s = await get('/api/corpus/summary');
    if (s.status === 200 && s.json && s.json.ok && s.json.data && s.json.data.poems > 300000) {
      console.log('   PASS summary: 总篇数=' + s.json.data.poems + ', 词=' + s.json.data.kinds['词']);
    } else {
      console.error('   FAIL summary', s);
      bad++;
    }

    console.log('3. 测试 /api/corpus/search?q=静女 ...');
    const sr = await get('/api/corpus/search?q=' + encodeURIComponent('静女'));
    if (sr.status === 200 && sr.json && sr.json.ok && sr.json.data.list.length > 0) {
      console.log('   PASS search: 匹配篇数=' + sr.json.data.total + ', 首篇=' + sr.json.data.list[0].title);
    } else {
      console.error('   FAIL search', sr);
      bad++;
    }

    console.log('4. 测试 /api/corpus/probe?q=静女其姝 ...');
    const pr = await get('/api/corpus/probe?q=' + encodeURIComponent('静女其姝'));
    if (pr.status === 200 && pr.json && pr.json.ok && pr.json.data.judge && pr.json.data.judge.ok) {
      console.log('   PASS probe: 判定通过=' + pr.json.data.judge.source.title + ', 全库命中篇数=' + pr.json.data.hits.length);
    } else {
      console.error('   FAIL probe', pr);
      bad++;
    }
  } finally {
    console.log('5. 正在关闭测试实例...');
    child.kill();
  }

  console.log(bad === 0 ? '=== 全部接口测试通过 ===' : '=== 存在失败项 ===');
  process.exitCode = bad ? 1 : 0;
}

run().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
