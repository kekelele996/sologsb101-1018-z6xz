/**
 * 坯胎入库（Blank）数据模型 —— 制胎间那头
 * 制胎间开出的坯胎在此入库，按坯胎编号与髹涂工序台那头的胎体（Body）对账。
 * 坯胎必须晾到含水率复测达标后，髹涂台才能给它编排头道漆。
 */

/** 坯胎材质：木胎 / 脱胎 / 金属胎（与 Body 对齐） */
export type BlankMaterial = 'wood' | 'lacquered' | 'metal';

/** 器型：碗 / 盘 / 盒 / 瓶（与 Body 对齐） */
export type BlankShape = 'bowl' | 'plate' | 'box' | 'vase';

/**
 * 对账状态：
 * - inStock  在库晾置中（尚未与髹涂台对账，或复测未达标继续晾）
 * - ready    复测达标且编号对上，可编排道次
 * - onFloor  已上漆（髹涂台那头已建道次），不退回
 * - held     挂起：编号或复测结论对不上，等人判
 */
export type BlankStatus = 'inStock' | 'ready' | 'onFloor' | 'held';

export interface Blank {
  /** 主键 */
  id: string;
  /** 坯胎编号，两头对账的唯一凭据（如 LQ-2401） */
  code: string;
  /** 坯胎材质 */
  material: BlankMaterial;
  /** 器型 */
  shape: BlankShape;
  /** 主要尺寸（毫米，取最大径） */
  sizeMm: number;
  /** 制胎班组 / 制胎师傅 */
  maker: string;
  /** 开坯完成、入晾房日期 yyyy-MM-dd */
  madeDate: string;
  /** 入库初测含水率（%） */
  initialMoisturePct: number;
  /**
   * 对账状态（由最近一次复测结论与编号对账结果共同决定）：
   * 复测未达标的压着等，复测过了再放回可编排。
   */
  status: BlankStatus;
  /** 挂起原因（status = held 时填写）：编号对不上 / 复测结论对不上 */
  holdReason: string;
  /** 最近一次复测结论：合格 / 不合格（升级回填的旧坯胎可能为 null） */
  lastRetestResult: RetestResult | null;
  /** 最近一次复测含水率（%） */
  lastMoisturePct: number | null;
  /** 最近一次复测日期 yyyy-MM-dd */
  lastRetestDate: string | null;
  /** 对账上的髹涂台胎体 id；对不上挂起时为 null */
  matchedBodyId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type BlankDraft = Omit<
  Blank,
  'id' | 'createdAt' | 'updatedAt' | 'status' | 'holdReason' | 'lastRetestResult' | 'lastMoisturePct' | 'lastRetestDate' | 'matchedBodyId'
>;

/** 复测结论：合格（可上漆）/ 不合格（压着继续晾） */
export type RetestResult = 'pass' | 'fail';

export const RETEST_RESULT_LABEL: Record<RetestResult, string> = {
  pass: '合格',
  fail: '不合格',
};

export const RETEST_RESULT_COLOR: Record<RetestResult, string> = {
  pass: '#2f6f4f',
  fail: '#b03a2e',
};

export const BLANK_MATERIAL_LABEL: Record<BlankMaterial, string> = {
  wood: '木胎',
  lacquered: '脱胎',
  metal: '金属胎',
};

export const BLANK_SHAPE_LABEL: Record<BlankShape, string> = {
  bowl: '碗',
  plate: '盘',
  box: '盒',
  vase: '瓶',
};

export const BLANK_STATUS_LABEL: Record<BlankStatus, string> = {
  inStock: '在库晾置',
  ready: '复测达标·可编排',
  onFloor: '已上漆',
  held: '挂起待判',
};

export const BLANK_STATUS_COLOR: Record<BlankStatus, string> = {
  inStock: '#8c8c8c',
  ready: '#2f6f4f',
  onFloor: '#3a6ea5',
  held: '#b03a2e',
};

export const BLANK_MATERIAL_OPTIONS: ReadonlyArray<{ value: BlankMaterial; label: string }> = [
  { value: 'wood', label: '木胎' },
  { value: 'lacquered', label: '脱胎' },
  { value: 'metal', label: '金属胎' },
];

export const BLANK_SHAPE_OPTIONS: ReadonlyArray<{ value: BlankShape; label: string }> = [
  { value: 'bowl', label: '碗' },
  { value: 'plate', label: '盘' },
  { value: 'box', label: '盒' },
  { value: 'vase', label: '瓶' },
];

export function createEmptyBlankDraft(): BlankDraft {
  return {
    code: '',
    material: 'wood',
    shape: 'bowl',
    sizeMm: 120,
    maker: '',
    madeDate: new Date().toISOString().slice(0, 10),
    initialMoisturePct: 14,
  };
}
