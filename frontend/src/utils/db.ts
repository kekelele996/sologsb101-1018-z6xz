/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Coat 增加 paintType 索引并回填历史记录
 *   v2 → v3：接入制胎间那头（坯胎入库单 blanks + 含水率复测 retests），
 *            旧数据只有胎体与道次，升级时按坯胎编号回填坯胎入库单，对不上的标来源不明
 * - 八张业务表的增删改查与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Body } from '@/types/body';
import type { Coat, PaintType } from '@/types/coat';
import type { Room } from '@/types/room';
import type { Polish } from '@/types/polish';
import type { Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';
import type { Blank, BlankMaterial, BlankShape, RetestResult } from '@/types/blank';
import type { MoistureRetest } from '@/types/retest';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gblacquer';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gblacquer:db-version',
  lastBackupAt: 'gblacquer:last-backup-at',
  uiPrefs: 'gblacquer:ui-prefs',
} as const;

export interface UiPrefs {
  /** 最近选中的胎体 */
  lastBodyId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBodyId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { lastBodyId: typeof parsed.lastBodyId === 'string' ? parsed.lastBodyId : null };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

/** 记录结构版本与最近备份时间，便于「本地数据」页回显 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class LacquerDatabase extends Dexie {
  bodies!: Table<Body, string>;
  coats!: Table<Coat, string>;
  rooms!: Table<Room, string>;
  polishes!: Table<Polish, string>;
  inlays!: Table<Inlay, string>;
  inspects!: Table<Inspect, string>;
  /** 制胎间：坯胎入库单 */
  blanks!: Table<Blank, string>;
  /** 制胎间：含水率复测 */
  retests!: Table<MoistureRetest, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      bodies: 'id, code, material, shape, state, updatedAt',
      coats: 'id, bodyId, seq, state, updatedAt',
      rooms: 'id, bodyId, date, verdict, updatedAt',
      polishes: 'id, bodyId, seq, method, updatedAt',
      inlays: 'id, bodyId, type, position, updatedAt',
      inspects: 'id, bodyId, verdict, date, updatedAt',
    });

    // v2：Coat 增加 paintType 索引；历史记录缺少 paintType 时按「生漆」回填
    this.version(2)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            const legal: PaintType[] = ['raw', 'color', 'topcoat'];
            if (!legal.includes(coat.paintType)) coat.paintType = 'raw';
            if (typeof coat.needRecheck !== 'boolean') coat.needRecheck = false;
            if (typeof coat.thicknessUm !== 'number') coat.thicknessUm = 40;
          });
      });

    // v3：接入制胎间（坯胎入库 + 含水率复测）。
    // 注意：Coat.bodyCode 只作编号快照存在记录上、不进索引——索引字段必须在每条记录上都存在，
    // 而升级事务里旧 coats 要先过校验才轮得到 bodyCode 回填，加进索引会导致整笔升级回滚。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
        blanks: 'id, code, status, updatedAt',
        retests: 'id, blankId, date, result, updatedAt',
      })
      .upgrade(async (tx) => {
        // 1) 旧道次回填漆种兜底字段，并按所属胎体补记坯胎编号快照（两头对账凭据）
        const oldBodies = await tx.table<Body>('bodies').toArray();
        const bodyCodeMap = new Map(oldBodies.map((body) => [body.id, body.code]));
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            if (typeof coat.bodyCode !== 'string' || coat.bodyCode.length === 0) {
              coat.bodyCode = bodyCodeMap.get(coat.bodyId) ?? '来源不明';
            }
          });

        // 2) 旧数据只有胎体和道次：按坯胎编号回填坯胎入库单，填不了的标来源不明
        const oldCoats = await tx.table<Coat>('coats').toArray();
        const coatsByBody = new Map<string, Coat[]>();
        oldCoats.forEach((coat) => {
          const list = coatsByBody.get(coat.bodyId) ?? [];
          list.push(coat);
          coatsByBody.set(coat.bodyId, list);
        });

        const blanks: Blank[] = [];
        oldBodies.forEach((body) => {
          const bodyCoats = coatsByBody.get(body.id) ?? [];
          const painted = bodyCoats.some((coat) => coat.state !== 'todo');
          // 旧档无复测数据：已上漆的按「复测达标回填」，没上漆的压在库里等复测
          const result: RetestResult = painted ? 'pass' : 'fail';
          blanks.push({
            id: `blank_legacy_${body.id}`,
            code: body.code,
            material: body.material as BlankMaterial,
            shape: body.shape as BlankShape,
            sizeMm: body.sizeMm,
            maker: '旧档回填',
            madeDate: new Date(body.createdAt).toISOString().slice(0, 10),
            initialMoisturePct: 0,
            status: painted ? 'onFloor' : 'inStock',
            holdReason: '',
            lastRetestResult: result,
            lastMoisturePct: null,
            lastRetestDate: null,
            matchedBodyId: body.id,
            createdAt: body.createdAt,
            updatedAt: body.updatedAt,
          });
        });

        // 道次引用了已不存在的胎体：按编号回填不出入库单，整条道次标「来源不明」挂起等判
        oldCoats.forEach((coat) => {
          if (!bodyCodeMap.has(coat.bodyId)) coat.bodyCode = '来源不明';
        });

        if (blanks.length > 0) await tx.table<Blank>('blanks').bulkPut(blanks);
      });
  }
}

export const db = new LacquerDatabase();

/** 八张业务表清单，事务中统一引用 */
const TABLE_LIST = [db.bodies, db.coats, db.rooms, db.polishes, db.inlays, db.inspects, db.blanks, db.retests];

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.bodies.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Body →（Coat / Room / Polish / Inlay）→ Inspect，id 固定便于深链命中 */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const bodies: Body[] = [
    {
      id: 'body_01',
      code: 'LQ-2401',
      material: 'wood',
      shape: 'bowl',
      sizeMm: 152,
      ownerName: '陈氏委托',
      state: 'coating',
      createdAt: now - 86400000 * 12,
      updatedAt: now - 86400000 * 2,
    },
    {
      id: 'body_02',
      code: 'LQ-2402',
      material: 'lacquered',
      shape: 'box',
      sizeMm: 96,
      ownerName: '工作室自藏',
      state: 'drying',
      createdAt: now - 86400000 * 9,
      updatedAt: now - 86400000,
    },
    {
      id: 'body_03',
      code: 'LQ-2403',
      material: 'metal',
      shape: 'vase',
      sizeMm: 210,
      ownerName: '市工艺美术馆',
      state: 'done',
      createdAt: now - 86400000 * 30,
      updatedAt: now - 86400000 * 4,
    },
    {
      // 髹涂台误把 LQ-2409 的道次建到了 LQ-2408 的坯胎编号上：对账挂起等判
      id: 'body_05',
      code: 'LQ-2409',
      material: 'wood',
      shape: 'plate',
      sizeMm: 180,
      ownerName: '林氏委托',
      state: 'pending',
      createdAt: now - 86400000 * 2,
      updatedAt: now - 86400000,
    },
  ];

  const coats: Coat[] = [
    { id: 'coat_0101', bodyId: 'body_01', bodyCode: 'LQ-2401', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02', thicknessUm: 40, state: 'done', needRecheck: false, createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 10 },
    { id: 'coat_0102', bodyId: 'body_01', bodyCode: 'LQ-2401', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-03-06', thicknessUm: 45, state: 'toPolish', needRecheck: true, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 2 },
    { id: 'coat_0103', bodyId: 'body_01', bodyCode: 'LQ-2401', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-12', thicknessUm: 30, state: 'todo', needRecheck: false, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'coat_0201', bodyId: 'body_02', bodyCode: 'LQ-2402', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03', thicknessUm: 35, state: 'done', needRecheck: false, createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 7 },
    { id: 'coat_0202', bodyId: 'body_02', bodyCode: 'LQ-2402', seq: 2, paintType: 'color', colorName: '赭石', coatDate: '2026-03-08', thicknessUm: 42, state: 'coated', needRecheck: true, createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'coat_0301', bodyId: 'body_03', bodyCode: 'LQ-2403', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-02-10', thicknessUm: 38, state: 'done', needRecheck: false, createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 25 },
    { id: 'coat_0302', bodyId: 'body_03', bodyCode: 'LQ-2403', seq: 2, paintType: 'color', colorName: '石绿', coatDate: '2026-02-18', thicknessUm: 44, state: 'done', needRecheck: false, createdAt: now - 86400000 * 20, updatedAt: now - 86400000 * 18 },
    { id: 'coat_0303', bodyId: 'body_03', bodyCode: 'LQ-2403', seq: 3, paintType: 'topcoat', colorName: '描金', coatDate: '2026-02-26', thicknessUm: 28, state: 'done', needRecheck: false, createdAt: now - 86400000 * 14, updatedAt: now - 86400000 * 4 },
    // 编号对不上：坯胎 LQ-2408 的道次被记到了胎体 LQ-2409（body_05）名下
    { id: 'coat_0501', bodyId: 'body_05', bodyCode: 'LQ-2408', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-11', thicknessUm: 40, state: 'todo', needRecheck: false, createdAt: now - 86400000 * 2, updatedAt: now - 86400000 },
  ];

  const rooms: Room[] = [
    { id: 'room_0101', bodyId: 'body_01', date: '2026-03-03', tempC: 24, humidityPct: 78, inAt: '09:00', outAt: '21:00', verdict: 'suitable', createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 10 },
    { id: 'room_0102', bodyId: 'body_01', date: '2026-03-07', tempC: 27, humidityPct: 56, inAt: '08:30', outAt: '20:00', verdict: 'dry', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'room_0201', bodyId: 'body_02', date: '2026-03-05', tempC: 23, humidityPct: 91, inAt: '10:00', outAt: '22:30', verdict: 'wet', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'room_0301', bodyId: 'body_03', date: '2026-02-20', tempC: 25, humidityPct: 76, inAt: '09:30', outAt: '21:30', verdict: 'suitable', createdAt: now - 86400000 * 18, updatedAt: now - 86400000 * 18 },
  ];

  const polishes: Polish[] = [
    { id: 'polish_0101', bodyId: 'body_01', seq: 1, grit: 600, method: 'water', durationMin: 35, operator: '王丽', createdAt: now - 86400000 * 9, updatedAt: now - 86400000 * 9 },
    { id: 'polish_0102', bodyId: 'body_01', seq: 2, grit: 1500, method: 'burnish', durationMin: 45, operator: '王丽', createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'polish_0201', bodyId: 'body_02', seq: 1, grit: 800, method: 'water', durationMin: 30, operator: '李成', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'polish_0301', bodyId: 'body_03', seq: 3, grit: 2000, method: 'burnish', durationMin: 60, operator: '王丽', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 * 4 },
  ];

  const inlays: Inlay[] = [
    { id: 'inlay_0101', bodyId: 'body_01', type: 'nacre', pattern: '缠枝莲', position: '外壁', materialNote: '0.8mm 螺钿片，刻纹嵌贴', createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 7 },
    { id: 'inlay_0201', bodyId: 'body_02', type: 'eggshell', pattern: '云纹', position: '盖面', materialNote: '鸭蛋壳拼贴后髹漆磨显', createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inlay_0301', bodyId: 'body_03', type: 'incisedGold', pattern: '折枝花', position: '通体', materialNote: '戗金，金粉入刻线', createdAt: now - 86400000 * 12, updatedAt: now - 86400000 * 12 },
    { id: 'inlay_0302', bodyId: 'body_03', type: 'goldTrace', pattern: '诗文', position: '外壁', materialNote: '描金，泥金细描', createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11 },
  ];

  const inspects: Inspect[] = [
    { id: 'inspect_0101', bodyId: 'body_03', verdict: 'pass', defectNote: '', inspector: '周衡', date: '2026-03-02', defectCoatSeq: null, defectRoomId: null, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inspect_0102', bodyId: 'body_02', verdict: 'rework', defectNote: '起皱（荫干过快）', inspector: '周衡', date: '2026-03-08', defectCoatSeq: 2, defectRoomId: 'room_0201', createdAt: now - 86400000, updatedAt: now - 86400000 },
  ];

  /* 制胎间那头：坯胎入库单（按坯胎编号与髹涂台对账） */
  const blanks: Blank[] = [
    { id: 'blank_01', code: 'LQ-2401', material: 'wood', shape: 'bowl', sizeMm: 152, maker: '赵师傅', madeDate: '2026-02-26', initialMoisturePct: 16.2, status: 'onFloor', holdReason: '', lastRetestResult: 'pass', lastMoisturePct: 10.8, lastRetestDate: '2026-03-01', matchedBodyId: 'body_01', createdAt: now - 86400000 * 13, updatedAt: now - 86400000 * 11 },
    { id: 'blank_02', code: 'LQ-2402', material: 'lacquered', shape: 'box', sizeMm: 96, maker: '脱胎组', madeDate: '2026-02-28', initialMoisturePct: 15.4, status: 'onFloor', holdReason: '', lastRetestResult: 'pass', lastMoisturePct: 11.2, lastRetestDate: '2026-03-02', matchedBodyId: 'body_02', createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 8 },
    { id: 'blank_03', code: 'LQ-2403', material: 'metal', shape: 'vase', sizeMm: 210, maker: '金工组', madeDate: '2026-02-04', initialMoisturePct: 0, status: 'onFloor', holdReason: '', lastRetestResult: 'pass', lastMoisturePct: 0, lastRetestDate: '2026-02-09', matchedBodyId: 'body_03', createdAt: now - 86400000 * 31, updatedAt: now - 86400000 * 26 },
    // 复测未达标：压着等，髹涂台那头还没有胎体，不许编排
    { id: 'blank_04', code: 'LQ-2404', material: 'wood', shape: 'bowl', sizeMm: 138, maker: '赵师傅', madeDate: '2026-03-06', initialMoisturePct: 17.5, status: 'inStock', holdReason: '', lastRetestResult: 'fail', lastMoisturePct: 13.6, lastRetestDate: '2026-03-10', matchedBodyId: null, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    // 复测达标、尚未转髹涂台：可编排
    { id: 'blank_05', code: 'LQ-2405', material: 'lacquered', shape: 'box', sizeMm: 105, maker: '脱胎组', madeDate: '2026-03-04', initialMoisturePct: 15.8, status: 'ready', holdReason: '', lastRetestResult: 'pass', lastMoisturePct: 11.0, lastRetestDate: '2026-03-09', matchedBodyId: null, createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 3 },
    // 复测结论对不上：读数 10.6% 已达标却判了不合格，挂起等人判
    { id: 'blank_06', code: 'LQ-2407', material: 'wood', shape: 'vase', sizeMm: 165, maker: '钱师傅', madeDate: '2026-03-02', initialMoisturePct: 16.0, status: 'held', holdReason: '复测结论对不上：含水率 10.6% 已达 ≤12% 标准，结论却为不合格，请人工判定', lastRetestResult: 'fail', lastMoisturePct: 10.6, lastRetestDate: '2026-03-10', matchedBodyId: null, createdAt: now - 86400000 * 9, updatedAt: now - 86400000 * 2 },
    // 编号对不上：入库单 LQ-2408，髹涂台却把道次记到了 LQ-2409 名下
    { id: 'blank_07', code: 'LQ-2408', material: 'wood', shape: 'plate', sizeMm: 180, maker: '孙师傅', madeDate: '2026-03-05', initialMoisturePct: 16.4, status: 'held', holdReason: '编号对不上：髹涂台有道次记在 LQ-2409 名下，待人工判定归属', lastRetestResult: 'pass', lastMoisturePct: 11.4, lastRetestDate: '2026-03-09', matchedBodyId: null, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 2 },
  ];

  const retests: MoistureRetest[] = [
    { id: 'retest_01a', blankId: 'blank_01', date: '2026-02-28', moisturePct: 12.8, result: 'fail', tester: '赵师傅', note: '木胎偏潮，继续阴晾', createdAt: now - 86400000 * 12, updatedAt: now - 86400000 * 12 },
    { id: 'retest_01b', blankId: 'blank_01', date: '2026-03-01', moisturePct: 10.8, result: 'pass', tester: '赵师傅', note: '达标，准上头道漆', createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11 },
    { id: 'retest_02', blankId: 'blank_02', date: '2026-03-02', moisturePct: 11.2, result: 'pass', tester: '脱胎组', note: '', createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 8 },
    { id: 'retest_03', blankId: 'blank_03', date: '2026-02-09', moisturePct: 0, result: 'pass', tester: '金工组', note: '金属胎不测含水率，登记放行', createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 26 },
    { id: 'retest_04a', blankId: 'blank_04', date: '2026-03-08', moisturePct: 15.2, result: 'fail', tester: '赵师傅', note: '', createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'retest_04b', blankId: 'blank_04', date: '2026-03-10', moisturePct: 13.6, result: 'fail', tester: '赵师傅', note: '仍偏高，压着继续晾', createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'retest_05', blankId: 'blank_05', date: '2026-03-09', moisturePct: 11.0, result: 'pass', tester: '脱胎组', note: '达标，可转髹涂台', createdAt: now - 86400000 * 3, updatedAt: now - 86400000 * 3 },
    { id: 'retest_06', blankId: 'blank_06', date: '2026-03-10', moisturePct: 10.6, result: 'fail', tester: '钱师傅', note: '仪器读数达标但当班判了不合格，需复核', createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'retest_07', blankId: 'blank_07', date: '2026-03-09', moisturePct: 11.4, result: 'pass', tester: '孙师傅', note: '', createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
  ];

  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(bodies);
    await db.coats.bulkPut(coats);
    await db.rooms.bulkPut(rooms);
    await db.polishes.bulkPut(polishes);
    await db.inlays.bulkPut(inlays);
    await db.inspects.bulkPut(inspects);
    await db.blanks.bulkPut(blanks);
    await db.retests.bulkPut(retests);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface LacquerSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  bodies: Body[];
  coats: Coat[];
  rooms: Room[];
  polishes: Polish[];
  inlays: Inlay[];
  inspects: Inspect[];
  /** v3 起新增；旧备份没有这两个集合，按空集合处理 */
  blanks?: Blank[];
  retests?: MoistureRetest[];
}

export async function exportSnapshot(): Promise<LacquerSnapshot> {
  const [bodies, coats, rooms, polishes, inlays, inspects, blanks, retests] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.rooms.toArray(),
    db.polishes.toArray(),
    db.inlays.toArray(),
    db.inspects.toArray(),
    db.blanks.toArray(),
    db.retests.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    bodies,
    coats,
    rooms,
    polishes,
    inlays,
    inspects,
    blanks,
    retests,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<LacquerSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  // blanks / retests 为 v3 新增，旧备份可缺省；其余六张表必须齐全
  const keys: Array<keyof LacquerSnapshot> = ['bodies', 'coats', 'rooms', 'polishes', 'inlays', 'inspects'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

export async function importSnapshot(snapshot: LacquerSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(snapshot.bodies);
    await db.coats.bulkPut(snapshot.coats);
    await db.rooms.bulkPut(snapshot.rooms);
    await db.polishes.bulkPut(snapshot.polishes);
    await db.inlays.bulkPut(snapshot.inlays);
    await db.inspects.bulkPut(snapshot.inspects);
    if (Array.isArray(snapshot.blanks)) await db.blanks.bulkPut(snapshot.blanks);
    if (Array.isArray(snapshot.retests)) await db.retests.bulkPut(snapshot.retests);
  });
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await Promise.all([
      db.bodies.clear(),
      db.coats.clear(),
      db.rooms.clear(),
      db.polishes.clear(),
      db.inlays.clear(),
      db.inspects.clear(),
      db.blanks.clear(),
      db.retests.clear(),
    ]);
  });
}

/** 清空并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [bodies, coats, rooms, polishes, inlays, inspects, blanks, retests] = await Promise.all([
    db.bodies.count(),
    db.coats.count(),
    db.rooms.count(),
    db.polishes.count(),
    db.inlays.count(),
    db.inspects.count(),
    db.blanks.count(),
    db.retests.count(),
  ]);
  return { bodies, coats, rooms, polishes, inlays, inspects, blanks, retests };
}

/* ------------------------------ 级联删除 ------------------------------ */

export async function removeBodyCascade(bodyId: string): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.coats.where('bodyId').equals(bodyId).delete();
    await db.rooms.where('bodyId').equals(bodyId).delete();
    await db.polishes.where('bodyId').equals(bodyId).delete();
    await db.inlays.where('bodyId').equals(bodyId).delete();
    await db.inspects.where('bodyId').equals(bodyId).delete();
    // 胎体删除后，已对账的坯胎退回在库（复测结论仍在）；编号对账关系解除
    const linkedBlanks = (await db.blanks.toArray()).filter((blank) => blank.matchedBodyId === bodyId);
    if (linkedBlanks.length > 0) {
      const now = Date.now();
      await db.blanks.bulkPut(
        linkedBlanks.map((blank) => ({
          ...blank,
          matchedBodyId: null,
          status: blank.lastRetestResult === 'pass' ? 'ready' : 'inStock',
          holdReason: '',
          updatedAt: now,
        })),
      );
    }
    await db.bodies.delete(bodyId);
  });
}
