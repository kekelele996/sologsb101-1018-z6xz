/**
 * 髹涂道次状态管理（Zustand）
 * 维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState, SOURCE_UNKNOWN } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { evaluateGate, type GateResult } from '@/utils/reconcile';
import { GATE_TEXT } from '@/types/reconcile';
import { useBodyStore } from './bodyStore';
import { useKilnStore } from './kilnStore';

/** 闸门未放行时抛出，页面捕获后提示「压着等」，不写入 */
export class GateBlockedError extends Error {}

/** 排道次 / 上漆前查这具坯胎最近一次复测与对账挂起；不放行则抛错 */
function assertGateOpen(bodyId: string): void {
  const body = useBodyStore.getState().bodies.find((item) => item.id === bodyId);
  if (!body) throw new GateBlockedError('胎体不存在');
  const { receipts, tests, holds } = useKilnStore.getState();
  const gate = evaluateGate(body, useCoatStore.getState().coats, receipts, tests, holds);
  if (gate.kind !== 'ok') {
    throw new GateBlockedError(GATE_TEXT[gate.kind]);
  }
}

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
}

interface CoatStoreState {
  coats: Coat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCoats: () => Promise<void>;
  coatsOfBody: (bodyId: string) => Coat[];
  createCoat: (draft: CoatDraft) => Promise<Coat>;
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<void>;
  removeCoat: (id: string) => Promise<void>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<void>;
  advanceState: (id: string) => Promise<void>;
  markRecheck: (bodyId: string, recheck: boolean) => Promise<void>;
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<void>;
  nextSeq: (bodyId: string) => number;
  /** 同器型自动带出上次漆种与间隔建议 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
  /** 某具坯胎的上漆闸门（最近复测 + 对账挂起） */
  gateOfBody: (bodyId: string) => GateResult;
}

export const useCoatStore = create<CoatStoreState>((set, get) => ({
  coats: [],
  loading: false,
  ready: false,
  error: '',

  async loadCoats() {
    set({ loading: true });
    try {
      const coats = await db.coats.toArray();
      coats.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId)));
      set({ coats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '道次读取失败' });
    }
  },

  coatsOfBody(bodyId) {
    return get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
  },

  async createCoat(draft) {
    // 排新道次前先看这具坯胎最近一次复测；没达标的压着等
    assertGateOpen(draft.bodyId);
    const now = Date.now();
    const body = useBodyStore.getState().bodies.find((item) => item.id === draft.bodyId);
    // 新道次按坯胎编号带来源编号，作为两边对账键
    const sourceCode = body?.code.trim() || SOURCE_UNKNOWN;
    const row: Coat = { ...draft, sourceCode, held: false, id: createId('coat'), createdAt: now, updatedAt: now };
    await db.coats.put(row);
    await get().loadCoats();
    // 道次变化后重跑对账（如带来源编号影响「来源不明」挂起）；失败不影响道次已落库
    await useKilnStore.getState().runReconcile();
    return row;
  },

  async updateCoat(id, patch) {
    await db.coats.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadCoats();
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    await db.coats.delete(id);
    if (target) {
      // 删除后按序重编号，保持 seq 连续
      const rest = get()
        .coats.filter((coat) => coat.bodyId === target.bodyId && coat.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
      if (rest.length > 0) await db.coats.bulkPut(rest);
    }
    await get().loadCoats();
  },

  async batchUpdate(ids, patch) {
    if (ids.length === 0) return;
    const now = Date.now();
    // 批量上漆（待涂 → 已上漆及以后）：压着的待涂道次不退回也不参与，只放行闸门开着的
    const movingToPainted = patch.state !== undefined && patch.state !== 'todo';
    const allowed = get().coats.filter((coat) => {
      if (!ids.includes(coat.id)) return false;
      if (!movingToPainted || coat.state !== 'todo') return true;
      if (coat.held) return false;
      const body = useBodyStore.getState().bodies.find((item) => item.id === coat.bodyId);
      if (!body) return false;
      const { receipts, tests, holds } = useKilnStore.getState();
      return evaluateGate(body, get().coats, receipts, tests, holds).kind === 'ok';
    });
    if (allowed.length === 0) return;
    const rows = allowed.map((coat) => ({ ...coat, ...patch, updatedAt: now }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
    await useKilnStore.getState().runReconcile();
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return;
    const next = nextCoatState(coat.state);
    if (next === coat.state) return;
    // 待涂 → 已涂 即上头道漆：排道次前必须复测达标；已上漆的后续推进不退回
    if (coat.state === 'todo') {
      if (coat.held) throw new GateBlockedError(GATE_TEXT.waiting);
      assertGateOpen(coat.bodyId);
    }
    await get().updateCoat(id, { state: next });
    // 上漆后重跑对账：若最近复测不达标会生成「复测结论对不上」挂起
    await useKilnStore.getState().runReconcile();
  },

  async markRecheck(bodyId, recheck) {
    const affected = get().coats.filter((coat) => coat.bodyId === bodyId && coat.state !== 'done');
    if (affected.length === 0) return;
    const now = Date.now();
    await db.coats.bulkPut(affected.map((coat) => ({ ...coat, needRecheck: recheck, updatedAt: now })));
    await get().loadCoats();
  },

  async reorderCoats(bodyId, orderedIds) {
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const rows = get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  nextSeq(bodyId) {
    const list = get().coats.filter((coat) => coat.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((coat) => coat.seq)) + 1;
  },

  suggestForBody(bodyId) {
    const bodies = useBodyStore.getState().bodies;
    const current = bodies.find((body) => body.id === bodyId);
    const previousBody = bodies.find((body) => body.id !== bodyId && current !== undefined && body.shape === current.shape);
    const previousCoat = previousBody
      ? get()
          .coats.filter((coat) => coat.bodyId === previousBody.id)
          .sort((a, b) => a.seq - b.seq)
          .pop()
      : undefined;
    const paintType = suggestPaintType(get().nextSeq(bodyId), previousCoat?.paintType, current?.shape);
    return {
      paintType,
      intervalHours: suggestIntervalHours(paintType),
      sourceCode: previousBody?.code ?? '',
      sourceColor: previousCoat?.colorName ?? '',
    };
  },

  gateOfBody(bodyId) {
    const body = useBodyStore.getState().bodies.find((item) => item.id === bodyId);
    if (!body) return { kind: 'hold' } as GateResult;
    const { receipts, tests, holds } = useKilnStore.getState();
    return evaluateGate(body, get().coats, receipts, tests, holds);
  },
}));

/** 道次派生选择器：按状态集合过滤 */
export function selectCoatsByStates(coats: Coat[], states: CoatState[]): Coat[] {
  if (states.length === 0) return coats;
  return coats.filter((coat) => states.includes(coat.state));
}
