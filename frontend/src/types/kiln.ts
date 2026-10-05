/**
 * 制胎间（Kiln）数据模型
 * 制胎间这头管两件事：「坯胎入库单」与「含水率复测」。
 * 坯胎出库晾坯后逐次复测含水率，复测达标（最近一次结论为 pass）后，
 * 髹涂工序台才允许编排 / 上漆道次。两边按坯胎编号 code 对账。
 */

/** 复测结论：达标 / 未达标 */
export type MoistureVerdict = 'pass' | 'fail';

/** 坯胎入库单：制胎间开出坯胎时登记 */
export interface KilnReceipt {
  id: string;
  /** 坯胎编号，两边对账键（与髹涂台 Body.code 对齐） */
  code: string;
  /** 入库日期 yyyy-MM-dd */
  inboundDate: string;
  /** 初测含水率（%） */
  initialMoisturePct: number;
  /** 制胎工 */
  maker: string;
  /** 备注（泥料 / 窑批等） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 含水率复测：同一坯胎可多次复测，以最近一次结论为准 */
export interface MoistureTest {
  id: string;
  /** 关联入库单 id */
  receiptId: string;
  /** 坯胎编号（冗余自入库单，复测结论按编号对账；入库单改编号时同步） */
  code: string;
  /** 复测日期 yyyy-MM-dd */
  testDate: string;
  /** 实测含水率（%） */
  moisturePct: number;
  /** 复测结论：含水率不高于上限即达标 */
  verdict: MoistureVerdict;
  /** 复测人 */
  tester: string;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type KilnReceiptDraft = Omit<KilnReceipt, 'id' | 'createdAt' | 'updatedAt'>;
export type MoistureTestDraft = Omit<MoistureTest, 'id' | 'createdAt' | 'updatedAt'>;

/** 含水率达标上限（%）：实测值 ≤ 上限即达标，可上头道漆 */
export const MOISTURE_LIMIT_PCT = 12;

export const MOISTURE_VERDICT_LABEL: Record<MoistureVerdict, string> = {
  pass: '达标',
  fail: '未达标',
};

export const MOISTURE_VERDICT_COLOR: Record<MoistureVerdict, string> = {
  pass: '#2f6f4f',
  fail: '#b03a2e',
};

export const MOISTURE_VERDICT_OPTIONS: ReadonlyArray<{ value: MoistureVerdict; label: string }> = [
  { value: 'pass', label: '达标' },
  { value: 'fail', label: '未达标' },
];

/** 按含水率上限判定复测结论 */
export function judgeMoisture(moisturePct: number): MoistureVerdict {
  return moisturePct <= MOISTURE_LIMIT_PCT ? 'pass' : 'fail';
}

export function createEmptyReceiptDraft(): KilnReceiptDraft {
  return {
    code: '',
    inboundDate: new Date().toISOString().slice(0, 10),
    initialMoisturePct: 16,
    maker: '',
    note: '',
  };
}

export function createEmptyTestDraft(receiptId: string, code: string): MoistureTestDraft {
  return {
    receiptId,
    code,
    testDate: new Date().toISOString().slice(0, 10),
    moisturePct: MOISTURE_LIMIT_PCT,
    verdict: 'pass',
    tester: '',
    note: '',
  };
}
