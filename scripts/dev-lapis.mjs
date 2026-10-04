// 개발용: 사무실 엔진과 LAPIS 대시보드를 임시 데이터 폴더로 함께 띄운다(실제 사용자 데이터를 건드리지 않는다).
//   node scripts/dev-lapis.mjs [대시보드포트=4410] [엔진포트=5100] [데이터폴더]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dashPort = Number(process.argv[2] || 4410), engPort = Number(process.argv[3] || 5100);
const data = process.argv[4] || mkdtempSync(join(tmpdir(), 'lapis-dev-'));
process.env.AI_OFFICE_HOME = join(data, 'engine');
const root = join(import.meta.dirname, '..');
const { startServer } = await import(pathToFileURL(join(root, 'src', 'server.mjs')).href);
const { createDashboardServer } = await import(pathToFileURL(join(root, 'dashboard', 'src', 'server.mjs')).href);
await startServer({ port: engPort, updateCheck: false });
const dash = createDashboardServer({ officeUrl: `http://127.0.0.1:${engPort}`, dataDir: join(data, 'lapis') });
dash.listen(dashPort, '127.0.0.1', () => console.log(`LAPIS 개발 서버: http://127.0.0.1:${dashPort}  (엔진 ${engPort}, 데이터 ${data})`));
