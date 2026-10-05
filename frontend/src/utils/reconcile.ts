/**
 * 两头对账引擎（制胎间 ↔ 髹涂工序台）
 *
 * 对账凭据：坯胎编号（Blank.code / Body.code / Coat.bodyCode）。
 * 排道次前先看这具坯胎最近一次含水率复测：
 *   - 没复测或复测不合格：压着等，不能编排 / 上头道漆
 *   - 复测合格且编号对得上：可编排
 *   - 编号或复测结论对不上：挂起等人判
 * 上了漆（已涂及以后）的道次不退回。
 *
 * 写入失败只退本侧重试：本模块所有跨头写回都各自 try/catch，
 * 一头失败不影响另一头已经落库的数据。
 */
import { db } from './db';
import { isMoistureConsistent } from './moisture';
import { MOISTURE_LIMIT_PCT } from './moisture';
import type { Blank } from '@/types/blank';
import type { Body } from '@/types/body';
import type { Coat } from '@/types/coat';

/** 编号对不上时道次快照上的占位编号 */
export const UNKNOWN_CODE = '来源不明';

/** 闸门结论：放行 / 压着等 / 挂起等判 */
export type GateKind = 'allowed' | 'waiting' | 'held';

/** 闸门原因码，页面按此决定提示文案与按钮 */
export type GateReason =
  | 'ok'
  | 'blank-unknown'
  | 'blank-held'
  | 'no-retest'
  | 'retest-fail'
  | 'retest-inconsistent'
  | 'code-mismatch'
  | 'orphan-code';

export interface GateResult {
  kind: GateKind;
  reason: GateReason;
  /** 供页面直接展示的一句话原因 */
  message: string;
  /** 命中的坯胎（如有） */
  blank?: Blank;
}

/** 已上漆（涂过）的道次一律不退回 */
export function isPainted(coat: Coat): boolean {
  return coat.state === 'coated' || coat.state === 'toPolish' || coat.state === 'done';
}

/** 取坯胎最近一次复测（复测表内自行按日期+创建时间排序） */
export async function latestRetestOf(blankId: string) {
  const rows = await db.retests.where('blankId').equals(blankId).toArray();
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
  return rows[rows.length - 1];
}

/** 纯计算：给定坯胎列表时按编号找到坯胎 */
export function findBlankByCode(blanks: Blank[], code: string): Blank | undefined {
  return blanks.find((blank) => blank.code === code);
}

/**
 * 排道次 / 上头道漆前的闸门。
 * @param bodyCode 髹涂台这具胎体的坯胎编号（取所属胎体现行 code）
 * @param painted 该胎体是否已有上了漆的道次（已上漆则不退回，直接放行）
 */
export function evaluateGate(
  bodyCode: string,
  painted: boolean,
  context: { blanks: Blank[]; bodies: Body[]; coats: Coat[] },
): GateResult {
  // 1) 来源不明：道次编号快照与任何入库单都对不上
  if (bodyCode === UNKNOWN_CODE) {
    return { kind: 'held', reason: 'blank-unknown', message: '该道次坯胎编号为「来源不明」，先挂起等人判定' };
  }

  // 2) 道次编号快照与胎体现行编号不一致：即便已上漆，编号对不上仍挂起等判
  const ownMismatch = context.coats.some(
    (coat) =>
      coat.bodyCode !== bodyCode &&
      coat.bodyCode !== UNKNOWN_CODE &&
      context.bodies.some((item) => item.id === coat.bodyId && item.code === bodyCode),
  );
  if (ownMismatch) {
    const bad = context.coats.find(
      (coat) =>
        coat.bodyCode !== bodyCode &&
        coat.bodyCode !== UNKNOWN_CODE &&
        context.bodies.some((item) => item.id === coat.bodyId && item.code === bodyCode),
    );
    return {
      kind: 'held',
      reason: 'code-mismatch',
      message: `道次上的坯胎编号为 ${bad?.bodyCode ?? '其他编号'}，与胎体编号 ${bodyCode} 对不上，先挂起等人判`,
    };
  }

  // 3) 已上漆的道次不退回：编号无异议时，后续流程照旧放行（不再卡含水率）
  if (painted) {
    return { kind: 'allowed', reason: 'ok', message: '已有上漆道次，不退回' };
  }

  const blank = findBlankByCode(context.blanks, bodyCode);

  // 4) 编号对不上：髹涂台有这具胎体但制胎间查无此入库单
  if (!blank) {
    const bodyExists = context.bodies.some((body) => body.code === bodyCode);
    if (bodyExists) {
      return {
        kind: 'held',
        reason: 'orphan-code',
        message: `制胎间查无编号 ${bodyCode} 的坯胎入库单，先挂起等人判`,
      };
    }
    return { kind: 'held', reason: 'blank-unknown', message: `编号 ${bodyCode} 两头都对不上，先挂起等人判` };
  }

  // 5) 入库单已挂起（编号或复测结论对不上）
  if (blank.status === 'held') {
    return {
      kind: 'held',
      reason: blank.holdReason.includes('编号') ? 'code-mismatch' : 'retest-inconsistent',
      message: blank.holdReason || '该坯胎已挂起，等人判定',
      blank,
    };
  }

  // 6) 本坯胎编号是否被别的胎体名下的道次盗用（编号对不上，挂起）
  const strayCoat = context.coats.find(
    (coat) => coat.bodyCode === bodyCode && !context.bodies.some((item) => item.id === coat.bodyId && item.code === bodyCode),
  );
  if (strayCoat) {
    const host = context.bodies.find((item) => item.id === strayCoat.bodyId);
    return {
      kind: 'held',
      reason: 'code-mismatch',
      message: `编号 ${bodyCode} 的道次被记到了 ${host?.code ?? '已删除胎体'} 名下，先挂起等人判`,
      blank,
    };
  }

  // 7) 看最近一次复测结论（以复测表为准，入库单上的快照只用于列表回显）
  if (blank.lastRetestResult === null) {
    return { kind: 'waiting', reason: 'no-retest', message: '该坯胎还没有含水率复测，先复测再编排', blank };
  }
  if (blank.lastRetestResult === 'fail') {
    // 读数与结论矛盾：读数已达标却判不合格（或反之），属「复测结论对不上」
    if (blank.lastMoisturePct !== null && isMoistureConsistent(blank.lastMoisturePct, 'fail') === false) {
      return {
        kind: 'held',
        reason: 'retest-inconsistent',
        message: `最近复测含水率 ${blank.lastMoisturePct}% 已达 ≤${MOISTURE_LIMIT_PCT}% 标准，结论却是不合格，挂起等人判`,
        blank,
      };
    }
    return {
      kind: 'waiting',
      reason: 'retest-fail',
      message: `最近复测含水率 ${blank.lastMoisturePct ?? '—'}% 未达标（≤${MOISTURE_LIMIT_PCT}%），压着继续晾`,
      blank,
    };
  }

  // 9) 复测合格
  if (blank.lastMoisturePct !== null && isMoistureConsistent(blank.lastMoisturePct, 'pass') === false) {
    return {
      kind: 'held',
      reason: 'retest-inconsistent',
      message: `最近复测含水率 ${blank.lastMoisturePct}% 高于 ${MOISTURE_LIMIT_PCT}% 标准，结论却判合格，挂起等人判`,
      blank,
    };
  }

  return { kind: 'allowed', reason: 'ok', message: '复测达标，可编排', blank };
}

/** 入库单重算后的目标状态（不含强制挂起理由时使用） */
export interface RecomputeResult {
  status: Blank['status'];
  holdReason: string;
  matchedBodyId: string | null;
}

type LatestRetest = Awaited<ReturnType<typeof latestRetestOf>>;

/**
 * 按最新复测与编号对账情况，重算一张入库单应处的状态。
 * 已上漆的不退回；挂起理由仍在的继续挂。
 */
export function recomputeBlankStatus(
  blank: Blank,
  context: { bodies: Body[]; coats: Coat[]; latest: LatestRetest | undefined },
): RecomputeResult {
  const { bodies, coats, latest } = context;
  const bodyCodeMap = new Map(bodies.map((body) => [body.id, body.code]));
  const body = bodies.find((item) => item.id === blank.matchedBodyId) ?? bodies.find((item) => item.code === blank.code) ?? null;
  const bodyId = body?.id ?? null;
  const bodyCoats = bodyId ? coats.filter((coat) => coat.bodyId === bodyId) : [];
  const painted = bodyCoats.some((coat) => isPainted(coat));

  // 编号对不上（情况一）：挂在本坯胎名下胎体上的道次，编号快照却是别的编号
  const localMismatch = bodyCoats.find((coat) => coat.bodyCode !== blank.code && coat.bodyCode !== UNKNOWN_CODE);
  // 编号对不上（情况二）：本坯胎的编号被道次记到了另一个编号的胎体名下（入库单可能尚未匹配胎体）
  const strayCoat = coats.find(
    (coat) => coat.bodyCode === blank.code && (bodyCodeMap.get(coat.bodyId) ?? UNKNOWN_CODE) !== blank.code,
  );
  const bad = localMismatch ?? strayCoat;
  if (bad) {
    const hostCode = bodyCodeMap.get(bad.bodyId) ?? '已删除胎体';
    return {
      status: 'held',
      holdReason: `编号对不上：编号 ${blank.code} 的道次记在了 ${hostCode} 名下，待人工判定归属`,
      matchedBodyId: bodyId,
    };
  }

  // 复测结论对不上：读数与结论自相矛盾
  if (latest && !isMoistureConsistent(latest.moisturePct, latest.result)) {
    return {
      status: 'held',
      holdReason: `复测结论对不上：含水率 ${latest.moisturePct}% 与「${latest.result === 'pass' ? '合格' : '不合格'}」结论矛盾，请人工判定`,
      matchedBodyId: bodyId,
    };
  }

  // 已上漆的不退回
  if (painted) return { status: 'onFloor', holdReason: '', matchedBodyId: bodyId };

  const result = latest?.result ?? blank.lastRetestResult;
  if (result === 'pass') return { status: 'ready', holdReason: '', matchedBodyId: bodyId };
  return { status: 'inStock', holdReason: '', matchedBodyId: bodyId };
}

export interface ReconcileReport {
  /** 本轮重算并写回的入库单数量 */
  checked: number;
  /** 状态实际发生变化的数量 */
  changed: number;
  /** 髹涂台那头的写回失败清单（另一头照旧，不回滚） */
  errors: string[];
}

/**
 * 全量对账：按坯胎编号把两头重新对齐，并重算每张入库单状态。
 * 跨头写回逐条 try/catch —— 某一（头）条写失败只跳过该条，其余照走。
 */
export async function reconcileAll(): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, changed: 0, errors: [] };
  const [blanks, bodies, coats] = await Promise.all([
    db.blanks.toArray(),
    db.bodies.toArray(),
    db.coats.toArray(),
  ]);

  for (const blank of blanks) {
    report.checked += 1;
    let latest: Awaited<ReturnType<typeof latestRetestOf>> | undefined;
    try {
      // eslint-disable-next-line no-await-in-loop
      latest = await latestRetestOf(blank.id);
    } catch {
      latest = undefined;
    }

    const next = recomputeBlankStatus(blank, { bodies, coats, latest });
    const lastResult = latest?.result ?? blank.lastRetestResult;
    const lastMoisture = latest?.moisturePct ?? blank.lastMoisturePct;
    const lastDate = latest?.date ?? blank.lastRetestDate;

    const changed =
      blank.status !== next.status ||
      blank.holdReason !== next.holdReason ||
      blank.matchedBodyId !== next.matchedBodyId ||
      blank.lastRetestResult !== lastResult ||
      blank.lastMoisturePct !== lastMoisture ||
      blank.lastRetestDate !== lastDate;

    if (!changed) continue;
    try {
      // 只回写制胎间这一头；髹涂台数据不受影响
      // eslint-disable-next-line no-await-in-loop
      await db.blanks.put({
        ...blank,
        status: next.status,
        holdReason: next.holdReason,
        matchedBodyId: next.matchedBodyId,
        lastRetestResult: lastResult,
        lastMoisturePct: lastMoisture,
        lastRetestDate: lastDate,
        updatedAt: Date.now(),
      });
      report.changed += 1;
    } catch (error) {
      // 写入失败只退这一头重试：本头跳过，另一头照旧
      report.errors.push(`${blank.code}: ${error instanceof Error ? error.message : '入库单写回失败'}`);
    }
  }

  // 反向核对：胎体有编号、入库单却查无此单；或道次快照标「来源不明」—— 挂起信息只在闸门体现，不在此自动造单
  return report;
}
