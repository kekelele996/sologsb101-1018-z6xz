/**
 * 迁移与对账规则验证（node + fake-indexeddb，esbuild 打包后运行）
 * 用法：node verify.cjs <scenario>
 *  upgrade   v2 旧库（仅胎体+道次）→ v3：按编号回填入库单，孤儿道次标来源不明
 *  gates     闸门：压着等 / 达标放行 / 编号或结论对不上挂起 / 已上漆不退回
 *  isolate   两阶段写入：一头失败只重试那一头，且不重复建档
 */
import 'fake-indexeddb/auto';
import { db, DB_SCHEMA_VERSION, seedDatabase } from '../src/utils/db';
import { evaluateGate, isPainted } from '../src/utils/reconcile';
import Dexie from 'dexie';

const pass = (name: string) => console.log(`  ✓ ${name}`);
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
const now = Date.now();

async function seedV2() {
  // 以 v2 结构建库写旧数据（coats 无 bodyCode）
  const oldDb = new Dexie('gblacquer');
  oldDb.version(1).stores({
    bodies: 'id, code, material, shape, state, updatedAt',
    coats: 'id, bodyId, seq, state, updatedAt',
    rooms: 'id, bodyId, date, verdict, updatedAt',
    polishes: 'id, bodyId, seq, method, updatedAt',
    inlays: 'id, bodyId, type, position, updatedAt',
    inspects: 'id, bodyId, verdict, date, updatedAt',
  });
  oldDb.version(2).stores({
    bodies: 'id, code, material, shape, state, updatedAt',
    coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
    rooms: 'id, bodyId, date, verdict, updatedAt',
    polishes: 'id, bodyId, seq, method, updatedAt',
    inlays: 'id, bodyId, type, position, updatedAt',
    inspects: 'id, bodyId, verdict, date, updatedAt',
  });
  await oldDb.table('bodies').bulkPut([
    { id: 'b1', code: 'OLD-1', material: 'wood', shape: 'bowl', sizeMm: 100, ownerName: '', state: 'coating', createdAt: now, updatedAt: now },
    { id: 'b2', code: 'OLD-2', material: 'wood', shape: 'box', sizeMm: 80, ownerName: '', state: 'pending', createdAt: now, updatedAt: now },
  ]);
  await oldDb.table('coats').bulkPut([
    { id: 'c1', bodyId: 'b1', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-01', thicknessUm: 40, state: 'done', needRecheck: false, createdAt: now, updatedAt: now },
    { id: 'c2', bodyId: 'b2', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02', thicknessUm: 40, state: 'todo', needRecheck: false, createdAt: now, updatedAt: now },
    { id: 'c3', bodyId: 'bgone', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03', thicknessUm: 40, state: 'todo', needRecheck: false, createdAt: now, updatedAt: now },
  ]);
  await oldDb.close();
}

async function scenarioUpgrade() {
  console.log('场景：v2 旧库（仅胎体+道次）升级到 v3');
  await seedV2();
  assert(DB_SCHEMA_VERSION === 3, 'schema version 应为 3');
  await db.open();

  const [blanks, coats] = await Promise.all([db.blanks.toArray(), db.coats.toArray()]);
  assert(blanks.length === 2, `应回填 2 张入库单，实际 ${blanks.length}`);
  pass('按坯胎编号回填了 2 张入库单');

  const blank1 = blanks.find((b) => b.code === 'OLD-1');
  const blank2 = blanks.find((b) => b.code === 'OLD-2');
  assert(blank1?.status === 'onFloor' && blank1?.lastRetestResult === 'pass' && blank1?.matchedBodyId === 'b1', 'OLD-1 应 onFloor/合格/对账 b1');
  pass('已上漆的旧胎体回填为 onFloor 且不退回');
  assert(blank2?.status === 'inStock' && blank2?.lastRetestResult === 'fail', 'OLD-2 应 inStock/不合格');
  pass('没上漆的旧胎体回填为在库晾置、压着等复测');

  const byId = Object.fromEntries(coats.map((c) => [c.id, c]));
  assert(byId.c1?.bodyCode === 'OLD-1' && byId.c2?.bodyCode === 'OLD-2', '旧道次按所属胎体编号回填');
  assert(byId.c3?.bodyCode === '来源不明', `孤儿道次应标来源不明，实际 ${byId.c3?.bodyCode}`);
  pass('旧道次按编号回填；查无胎体的道次标「来源不明」');
}

async function scenarioGates() {
  console.log('场景：闸门规则（种子数据）');
  await db.open();
  if ((await db.bodies.count()) === 0) await seedDatabase();
  const [bodies, coats, blanks] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.blanks.toArray(),
  ]);
  const gate = (code: string) => {
    const painted = coats.some((c) => bodies.find((b) => b.id === c.bodyId)?.code === code && isPainted(c));
    return evaluateGate(code, painted, { bodies, blanks, coats });
  };
  const expect = (code: string, kind: string, reason: string | null, label: string) => {
    const g = gate(code);
    assert(g.kind === kind && (reason === null || g.reason === reason), `${code} 期望 ${kind}/${reason}，实际 ${g.kind}/${g.reason}（${g.message}）`);
    pass(label);
  };

  expect('LQ-2401', 'allowed', null, '已上漆的道次不退回，后续照旧放行');
  expect('LQ-2404', 'waiting', 'retest-fail', '复测未达标的压着等');
  expect('LQ-2405', 'allowed', null, '复测过了放回可编排');
  expect('LQ-2407', 'held', 'retest-inconsistent', '复测读数与结论矛盾 → 挂起');
  expect('LQ-2408', 'held', 'code-mismatch', '编号串台（道次记在 LQ-2409 名下）→ 挂起');
  expect('LQ-2409', 'held', 'code-mismatch', '胎体名下道次编号是 LQ-2408（编号对不上）→ 挂起等人判');
}

async function scenarioIsolate() {
  console.log('场景：两阶段写入隔离与重试幂等');
  await db.open();
  if ((await db.bodies.count()) === 0) await seedDatabase();
  const { useBlankStore } = await import('../src/stores/blankStore');
  const { useBodyStore } = await import('../src/stores/bodyStore');
  await Promise.all([useBlankStore.getState().loadBlanks(), useBodyStore.getState().loadBodies()]);

  const target = useBlankStore.getState().blanks.find((b) => b.code === 'LQ-2405')!;
  assert(target?.status === 'ready', 'LQ-2405 初始应为 ready');

  const r1 = await useBlankStore.getState().admitToFloor(target.id);
  assert(r1.body.ok && r1.blank.ok, '首次转入两头都应成功');
  pass('转入：髹涂台先建档，制胎间再回写对账关系');
  assert((await db.bodies.where('code').equals('LQ-2405').count()) === 1, '同编号胎体只建 1 个');

  // 模拟第二头失败：把入库单方面状态拨回 ready（第一头胎体已落库），再重试
  await db.blanks.update(target.id, { status: 'ready', matchedBodyId: null });
  await useBlankStore.getState().loadBlanks();
  const r2 = await useBlankStore.getState().admitToFloor(target.id);
  assert(r2.body.ok && r2.blank.ok, '重试应两头成功（第一头幂等复用）');
  assert((await db.bodies.where('code').equals('LQ-2405').count()) === 1, '重试不得重复建档');
  pass('一头失败只重试这一头：胎体幂等复用，入库单补回对账关系');
}

const scenario = process.argv[2];
void (async () => {
  try {
    if (scenario === 'upgrade') await scenarioUpgrade();
    else if (scenario === 'gates') await scenarioGates();
    else if (scenario === 'isolate') await scenarioIsolate();
    else throw new Error(`未知场景 ${scenario}`);
    console.log('通过 ✅');
  } catch (err) {
    console.error('✗', err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
