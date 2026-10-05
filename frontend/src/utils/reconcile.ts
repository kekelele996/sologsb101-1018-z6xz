/**
 * 制胎间 ↔ 髹涂工序台 对账规则（纯函数，不触碰数据库）
 *
 * 约定：
 * - 两边按坯胎编号 code 对账；编号或复测结论对不上 → 生成挂起记录等人判。
 * - 排道次前看该坯胎「最近一次复测」：未达标 / 无复测 → 压着等（todo 道次 held=true）；
 *   复测达标 → 放回可编排（held=false）。
 * - 上了漆的道次（state !== 'todo'）不退回，永不打 held。
 * - 已由人工判定（status=resolved）的问题：问题仍在则保留判定，问题消失则清除。
 */
import type { Body } from '@/types/body';
import type { Coat } from '@/types/coat';
import { SOURCE_UNKNOWN } from '@/types/coat';
import type { KilnReceipt, MoistureTest } from '@/types/kiln';
import type { GateKind, HoldReason, Reconciliation } from '@/types/reconcile';

/** 道次是否已上漆（已涂 / 待打磨 / 已完成）；已上漆不退回 */
export function isCoatPainted(coat: Coat): boolean {
  return coat.state !== 'todo';
}

/** 取某编号最近一次复测（按日期 + 创建时间） */
export function latestTestOf(code: string, tests: MoistureTest[]): MoistureTest | undefined {
  return tests
    .filter((test) => test.code === code)
    .sort((a, b) =>
      a.testDate === b.testDate ? b.createdAt - a.createdAt : a.testDate < b.testDate ? 1 : -1,
    )[0];
}

export function issueKey(reason: HoldReason, key: string): string {
  return `${reason}:${key}`;
}

/** 该坯胎是否存在某原因的未决挂起 */
function openHold(
  holds: Reconciliation[],
  reason: HoldReason,
  predicate: (hold: Reconciliation) => boolean,
): Reconciliation | undefined {
  return holds.find((hold) => hold.status === 'hold' && hold.reason === reason && predicate(hold));
}

export interface GateResult {
  kind: GateKind;
  /** 最近一次复测（kind=waiting 时一定有） */
  test?: MoistureTest;
  /** 命中的未决挂起（kind=hold 时一定有） */
  hold?: Reconciliation;
}

/**
 * 排道次 / 上漆前的闸门判定（按一具坯胎）。
 * 顺序：先看对账挂起，再看最近复测结论。
 */
export function evaluateGate(
  body: Body,
  coats: Coat[],
  receipts: KilnReceipt[],
  tests: MoistureTest[],
  holds: Reconciliation[],
): GateResult {
  const code = body.code.trim();
  const bodyCoats = coats.filter((coat) => coat.bodyId === body.id);

  const unknownCoat = bodyCoats.find((coat) => !coat.bodyId || coat.sourceCode === SOURCE_UNKNOWN);
  const sourceHold = unknownCoat
    ? openHold(holds, 'sourceUnknown', (hold) => hold.coatId === unknownCoat.id)
    : undefined;
  if (sourceHold) return { kind: 'hold', hold: sourceHold };

  const missingHold = openHold(holds, 'missingReceipt', (hold) => hold.bodyId === body.id);
  if (missingHold) return { kind: 'hold', hold: missingHold };

  const conclusionHold = openHold(holds, 'conclusionMismatch', (hold) => hold.bodyId === body.id);
  if (conclusionHold) return { kind: 'hold', hold: conclusionHold };

  const hasReceipt = code.length > 0 && receipts.some((receipt) => receipt.code === code);
  if (!hasReceipt) return { kind: 'hold' };

  const latest = latestTestOf(code, tests);
  if (!latest) return { kind: 'none' };
  return latest.verdict === 'pass' ? { kind: 'ok', test: latest } : { kind: 'waiting', test: latest };
}

export interface ReconcileResult {
  /** 需要写入（含新出现与仍未判定）的挂起 */
  upserts: Reconciliation[];
  /** 已不存在、需删除的挂起 issueKey（resolved 且问题消失的也在此） */
  removeKeys: string[];
  /** 现在应被压排的待涂道次 id 集合 */
  heldCoatIds: Set<string>;
  /** bodyId → 闸门结果，供页面 / store 直接用 */
  gates: Map<string, GateResult>;
}

interface IssueSpec {
  key: string;
  reason: HoldReason;
  code: string;
  bodyId: string;
  receiptId: string;
  coatId: string;
  detail: string;
}

/**
 * 一旦生成只能由人工判定的原因：来源归属与起皱责任不能靠新复测自动销单。
 * 编号对得上 / 入库单补齐这类事实问题则可随对账自动清除。
 */
const MANUAL_ONLY_REASONS: ReadonlySet<HoldReason> = new Set(['sourceUnknown', 'conclusionMismatch']);

export function reconcileAll(
  bodies: Body[],
  coats: Coat[],
  receipts: KilnReceipt[],
  tests: MoistureTest[],
  existing: Reconciliation[],
  now: number = Date.now(),
): ReconcileResult {
  const specs: IssueSpec[] = [];
  const receiptCodes = new Set(receipts.map((receipt) => receipt.code.trim()).filter((code) => code.length > 0));
  const bodyCodeToId = new Map(bodies.map((body) => [body.code.trim(), body.id]));

  // 1) 旧道次回填不到编号 / 成了孤儿 → 来源不明
  coats.forEach((coat) => {
    const body = bodies.find((item) => item.id === coat.bodyId);
    const code = body?.code.trim() ?? '';
    if (!body || code.length === 0 || coat.sourceCode === SOURCE_UNKNOWN) {
      specs.push({
        key: issueKey('sourceUnknown', coat.id),
        reason: 'sourceUnknown',
        code: coat.sourceCode && coat.sourceCode !== SOURCE_UNKNOWN ? coat.sourceCode : code,
        bodyId: coat.bodyId ?? '',
        receiptId: '',
        coatId: coat.id,
        detail: `第 ${coat.seq} 道旧道次回填不到坯胎编号，来源不明，等人判定归属`,
      });
    }
  });

  // 2) 髹涂台有胎体、制胎间没开入库单 → 缺入库单（编号对不上）
  bodies.forEach((body) => {
    const code = body.code.trim();
    if (code.length === 0 || receiptCodes.has(code)) return;
    specs.push({
      key: issueKey('missingReceipt', body.id),
      reason: 'missingReceipt',
      code,
      bodyId: body.id,
      receiptId: '',
      coatId: '',
      detail: `胎体 ${code} 在髹涂台账中存在，但制胎间没有对应入库单，编号先挂起`,
    });
  });

  // 3) 制胎间开了单、髹涂台没有该编号坯胎 → 编号对不上
  receipts.forEach((receipt) => {
    const code = receipt.code.trim();
    if (code.length === 0 || bodyCodeToId.has(code)) return;
    specs.push({
      key: issueKey('codeMismatch', receipt.id),
      reason: 'codeMismatch',
      code,
      bodyId: '',
      receiptId: receipt.id,
      coatId: '',
      detail: `入库单 ${code}（${receipt.inboundDate}）在髹涂台账中查无此编号坯胎`,
    });
  });

  // 4) 已上漆但最近复测不达标 → 复测结论对不上（起皱责任不清）
  bodies.forEach((body) => {
    const code = body.code.trim();
    const latest = latestTestOf(code, tests);
    const painted = coats.filter((coat) => coat.bodyId === body.id && isCoatPainted(coat));
    if (latest && latest.verdict === 'fail' && painted.length > 0) {
      specs.push({
        key: issueKey('conclusionMismatch', body.id),
        reason: 'conclusionMismatch',
        code,
        bodyId: body.id,
        receiptId: receipts.find((receipt) => receipt.code === code)?.id ?? '',
        coatId: painted.sort((a, b) => a.seq - b.seq)[0]!.id,
        detail: `${code} 已有 ${painted.length} 道上漆，但最近一次复测（${latest.testDate}）含水率 ${latest.moisturePct}% 未达标，疑似没晾透先上漆`,
      });
    }
  });

  const specKeys = new Set(specs.map((spec) => spec.key));
  const upserts: Reconciliation[] = [];
  const removeKeys: string[] = [];

  specs.forEach((spec) => {
    const prior = existing.find((hold) => hold.issueKey === spec.key);
    if (prior) {
      // 已判定的保留判定结论与判定人；未决的刷新说明
      if (prior.status === 'resolved') return;
      upserts.push({ ...prior, ...specFields(spec), updatedAt: now });
    } else {
      upserts.push({
        issueKey: spec.key,
        ...specFields(spec),
        status: 'hold',
        resolver: '',
        resolveNote: '',
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  // 问题已消失：事实类挂起自动清除；责任 / 归属类挂起即使条件消失也保留，等人判
  existing.forEach((hold) => {
    if (specKeys.has(hold.issueKey)) return;
    if (MANUAL_ONLY_REASONS.has(hold.reason)) return;
    removeKeys.push(hold.issueKey);
  });

  // 5) 压排：仅作用于待涂道次；已上漆不退回
  const heldCoatIds = new Set<string>();
  const gates = new Map<string, GateResult>();
  bodies.forEach((body) => {
    const gate = evaluateGate(body, coats, receipts, tests, existing);
    gates.set(body.id, gate);
    if (gate.kind === 'ok') return;
    coats
      .filter((coat) => coat.bodyId === body.id && !isCoatPainted(coat))
      .forEach((coat) => heldCoatIds.add(coat.id));
  });

  return { upserts, removeKeys, heldCoatIds, gates };
}

function specFields(spec: IssueSpec): Omit<Reconciliation, 'issueKey' | 'status' | 'resolver' | 'resolveNote' | 'createdAt' | 'updatedAt'> {
  return {
    reason: spec.reason,
    code: spec.code,
    bodyId: spec.bodyId,
    receiptId: spec.receiptId,
    coatId: spec.coatId,
    detail: spec.detail,
  };
}
