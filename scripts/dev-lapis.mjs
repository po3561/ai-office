// 개발용: 사무실 엔진과 LAPIS 대시보드를 임시 데이터 폴더로 함께 띄운다(실제 사용자 데이터를 건드리지 않는다).
//   node scripts/dev-lapis.mjs [대시보드포트=4410] [엔진포트=5100] [데이터폴더] [--fake-cloudflare]
// --fake-cloudflare: 가짜 Cloudflare 서버를 함께 띄우고 연결해 둔다 → 웹 배포 화면을 실제 계정 없이 끝까지 시험할 수 있다.
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fake = process.argv.includes('--fake-cloudflare');
const dashPort = Number(args[0] || 4410), engPort = Number(args[1] || 5100);
const data = args[2] || mkdtempSync(join(tmpdir(), 'lapis-dev-'));
process.env.AI_OFFICE_HOME = join(data, 'engine');

if (fake) {
  const kv = [];
  const cf = createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      const out = (result, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: status < 400, errors: [], result })); };
      if (path === '/accounts') return out([{ id: 'acc1', name: '시험용 계정' }]);
      if (path === '/accounts/acc1/workers/subdomain') return out({ subdomain: 'demo' });
      if (path === '/accounts/acc1/ai/models/search') return out([{ name: '@cf/meta/llama-3.1-8b-instruct' }]);
      if (path === '/accounts/acc1/storage/kv/namespaces') { if (req.method === 'GET') return out(kv); const ns = { id: 'ns' + kv.length, title: JSON.parse(Buffer.concat(chunks)).title }; kv.push(ns); return out(ns); }
      return out({});
    });
  });
  await new Promise((r) => cf.listen(0, '127.0.0.1', r));
  process.env.LAPIS_CF_BASE = `http://127.0.0.1:${cf.address().port}`;
}

const root = join(import.meta.dirname, '..');
const engine = await import(pathToFileURL(join(root, 'src', 'server.mjs')).href);
const { createDashboardServer } = await import(pathToFileURL(join(root, 'dashboard', 'src', 'server.mjs')).href);
if (fake) await engine.secrets.set('cloudflare', 'dev-' + 'x'.repeat(36));
await engine.startServer({ port: engPort, updateCheck: false });
const dash = createDashboardServer({ officeUrl: `http://127.0.0.1:${engPort}`, dataDir: join(data, 'lapis') });
dash.listen(dashPort, '127.0.0.1', () => console.log(`LAPIS 개발 서버: http://127.0.0.1:${dashPort}  (엔진 ${engPort}, 데이터 ${data}${fake ? ', 가짜 Cloudflare' : ''})`));
