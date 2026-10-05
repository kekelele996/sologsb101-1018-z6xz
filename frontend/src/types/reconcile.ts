/**
 * 对账挂起（Reconciliation）数据模型
 * 制胎间与髹涂工序台两边按坯胎编号 code 对账：
 * 编号对不上、或复测结论与髹涂状态矛盾时，先挂起等人工判定。
 * 挂起记录主键固定为 issueKey（派生规则见 utils/reconcile.ts），幂等 upsert。
 */

/**
 * 挂起原因：
 * - sourceUnknown：旧道次回填不到坯胎编号（来源不明）
 * - codeMismatch：入库单编号在髹涂台账无对应坯胎
 * - missingReceipt：可编排坯胎缺制胎间入库单
 * - conclusionMismatch：已上漆道次的最近复测不达标 / 无复测（起皱责任不清）
 */
export type HoldReason = 'sourceUnknown' | 'codeMismatch' | 'missingReceipt' | 'conclusionMismatch';

export interface Reconciliation {
  /** 主键：按原因 + 编号 + 道次派生出的稳定 key */
  issueKey: string;
  reason: HoldReason;
  /** 对账用到的坯胎编号（可能来自任意一头） */
  code: string;
  /** 关联髹涂台 bodyId（无则空串） */
  bodyId: string;
  /** 关联入库单 id（无则空串） */
  receiptId: string;
  /** 关联道次 id（仅 conclusionMismatch 用） */
  coatId: string;
  /** 挂起说明 */
  detail: string;
  /** 处置状态：挂起中 / 已判定 */
  status: 'hold' | 'resolved';
  /** 判定人 */
  resolver: string;
  /** 判定说明 */
  resolveNote: string;
  createdAt: number;
  updatedAt: number;
}

export type ReconciliationDraft = Omit<Reconciliation, 'createdAt' | 'updatedAt'>;

export const HOLD_REASON_LABEL: Record<HoldReason, string> = {
  sourceUnknown: '来源不明',
  codeMismatch: '编号对不上',
  missingReceipt: '缺入库单',
  conclusionMismatch: '复测结论对不上',
};

export const HOLD_REASON_COLOR: Record<HoldReason, string> = {
  sourceUnknown: '#8c8c8c',
  codeMismatch: '#c9963c',
  missingReceipt: '#3a6ea5',
  conclusionMismatch: '#b03a2e',
};

export const HOLD_STATUS_LABEL: Record<Reconciliation['status'], string> = {
  hold: '挂起中',
  resolved: '已判定',
};

/** 可编排（允许排新道次 / 上头道漆）的判定文案 */
export type GateKind = 'ok' | 'waiting' | 'none' | 'hold';

export const GATE_TEXT: Record<GateKind, string> = {
  ok: '复测达标，可编排',
  waiting: '复测未达标，压着等',
  none: '暂无复测，压着等',
  hold: '对账挂起，等人判',
};
