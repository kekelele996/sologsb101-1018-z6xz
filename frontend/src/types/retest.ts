/**
 * 含水率复测（MoistureRetest）数据模型 —— 制胎间那头
 * 坯胎晾置期间逐次复测含水率；排道次前只认该坯胎「最近一次」复测结论。
 */
import type { RetestResult } from './blank';

export interface MoistureRetest {
  /** 主键 */
  id: string;
  /** 所属坯胎 id（制胎间这头） */
  blankId: string;
  /** 复测日期 yyyy-MM-dd */
  date: string;
  /** 复测含水率（%） */
  moisturePct: number;
  /** 复测结论：合格（可上漆）/ 不合格（压着继续晾） */
  result: RetestResult;
  /** 复测人 */
  tester: string;
  /** 仪器读数 / 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type MoistureRetestDraft = Omit<MoistureRetest, 'id' | 'createdAt' | 'updatedAt'>;

export const RETEST_RESULT_OPTIONS: ReadonlyArray<{ value: RetestResult; label: string }> = [
  { value: 'pass', label: '合格（可上漆）' },
  { value: 'fail', label: '不合格（继续晾）' },
];

export function createEmptyRetestDraft(blankId: string, moisturePct: number): MoistureRetestDraft {
  return {
    blankId,
    date: new Date().toISOString().slice(0, 10),
    moisturePct,
    result: 'fail',
    tester: '',
    note: '',
  };
}
