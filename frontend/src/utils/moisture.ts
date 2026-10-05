/**
 * 坯胎含水率判定工具（制胎间）
 * 上头道漆前坯胎含水率必须降到达标线以下；不达标继续晾置。
 */
import type { RetestResult } from '@/types/blank';

/** 含水率达标上限（%）：不高于该值才可上漆 */
export const MOISTURE_LIMIT_PCT = 12;

/**
 * 按含水率读数判定复测结论。
 * 注意：仪器自动判定仅供填表默认值，复测人仍可改结论；
 * 读数与结论矛盾（如读数达标却判不合格）会在对账时按「复测结论对不上」挂起。
 */
export function judgeMoisture(moisturePct: number): RetestResult {
  return Number.isFinite(moisturePct) && moisturePct <= MOISTURE_LIMIT_PCT ? 'pass' : 'fail';
}

/** 读数与结论是否自洽（用于挂起对账） */
export function isMoistureConsistent(moisturePct: number, result: RetestResult): boolean {
  return judgeMoisture(moisturePct) === result;
}

/** 达标线提示文案 */
export function moistureLimitHint(): string {
  return `上漆达标线：含水率 ≤ ${MOISTURE_LIMIT_PCT}%`;
}
