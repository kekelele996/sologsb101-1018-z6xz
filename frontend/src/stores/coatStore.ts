/**
 * 髹涂道次状态管理（Zustand）
 * 维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态。
 * 排道次 / 上头道漆前先过制胎间含水率闸门：复测未达标压着等，编号或结论对不上挂起等判；
 * 已上漆的道次不退回。跨头对账写回失败不阻断本头，只影响另一侧状态回显。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { evaluateGate, isPainted, UNKNOWN_CODE } from '@/utils/reconcile';
import { useBodyStore } from './bodyStore';
import { useBlankStore } from './blankStore';

/** 闸门拦截错误：页面捕获后直接提示，不当作系统异常 */
export class GateBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateBlockedError';
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
  /**
   * 排道次 / 上头道漆前的制胎间闸门。
   * @param forCoating true=准备上漆（todo→coated），已有上漆道次时不退回；false=仅编排待涂道次
   */
  checkGate: (bodyId: string, forCoating: boolean) => ReturnType<typeof evaluateGate>;
  /** 同器型自动带出上次漆种与间隔建议 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
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
    const bodies = useBodyStore.getState().bodies;
    const body = bodies.find((item) => item.id === draft.bodyId);
    const existing = get().coats.filter((coat) => coat.bodyId === draft.bodyId);
    // 头道漆（该胎体此前一道都没有）排道次前，先看坯胎最近一次复测
    if (existing.length === 0) {
      const gate = evaluateGate(
        body?.code ?? UNKNOWN_CODE,
        false,
        { bodies, blanks: useBlankStore.getState().blanks, coats: get().coats },
      );
      if (gate.kind !== 'allowed') throw new GateBlockedError(gate.message);
    }
    const now = Date.now();
    const row: Coat = {
      ...draft,
      // 坯胎编号快照以胎体现行编号为准（闸门已确认对得上）
      bodyCode: body?.code ?? (draft.bodyCode || UNKNOWN_CODE),
      id: createId('coat'),
      createdAt: now,
      updatedAt: now,
    };
    await db.coats.put(row);
    await get().loadCoats();
    // 道次落库后异步对账一次（如把对应入库单置为已上漆）；失败不影响本头
    void useBlankStore.getState().reconcile().catch(() => undefined);
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
    // 批量改成「已涂」属于上头道漆：逐具体检闸门，未过的压下并返回拦截清单
    if (patch.state === 'coated') {
      const bodies = useBodyStore.getState().bodies;
      const blanks = useBlankStore.getState().blanks;
      const blocked: string[] = [];
      const allowedIds: string[] = [];
      ids.forEach((id) => {
        const coat = get().coats.find((item) => item.id === id);
        if (!coat) return;
        const body = bodies.find((item) => item.id === coat.bodyId);
        const bodyCoats = get().coats.filter((item) => item.bodyId === coat.bodyId);
        const painted = bodyCoats.some((item) => isPainted(item));
        const gate = evaluateGate(body?.code ?? UNKNOWN_CODE, painted, { bodies, blanks, coats: get().coats });
        if (gate.kind === 'allowed' || painted) allowedIds.push(id);
        else blocked.push(body?.code ?? coat.bodyId);
      });
      if (allowedIds.length === 0) {
        throw new GateBlockedError(`共 ${blocked.length} 件坯胎未过含水率/编号闸门：${[...new Set(blocked)].join('、')}`);
      }
      const now = Date.now();
      const rows = get()
        .coats.filter((coat) => allowedIds.includes(coat.id))
        .map((coat) => ({ ...coat, ...patch, updatedAt: now }));
      await db.coats.bulkPut(rows);
      await get().loadCoats();
      void useBlankStore.getState().reconcile().catch(() => undefined);
      if (blocked.length > 0) {
        throw new GateBlockedError(`已放行 ${allowedIds.length} 道；${[...new Set(blocked)].join('、')} 未过闸门被压下`);
      }
      return;
    }
    const now = Date.now();
    const rows = get()
      .coats.filter((coat) => ids.includes(coat.id))
      .map((coat) => ({ ...coat, ...patch, updatedAt: now }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return;
    const next = nextCoatState(coat.state);
    if (next === coat.state) return;
    // 待涂 → 已涂：这是真上头道漆，必须过制胎间闸门（复测达标 + 编号对得上）
    if (coat.state === 'todo' && next === 'coated') {
      const bodies = useBodyStore.getState().bodies;
      const body = bodies.find((item) => item.id === coat.bodyId);
      const bodyCoats = get().coats.filter((item) => item.bodyId === coat.bodyId);
      const painted = bodyCoats.some((item) => item.id !== coat.id && isPainted(item));
      const gate = evaluateGate(body?.code ?? (coat.bodyCode || UNKNOWN_CODE), painted, {
        bodies,
        blanks: useBlankStore.getState().blanks,
        coats: get().coats,
      });
      if (gate.kind !== 'allowed') throw new GateBlockedError(gate.message);
    }
    await get().updateCoat(id, { state: next });
    // 已上漆：触发对账把入库单置为已上漆（不退回）；对账写回失败不影响道次这头
    if (next === 'coated') void useBlankStore.getState().reconcile().catch(() => undefined);
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

  checkGate(bodyId, forCoating) {
    const bodies = useBodyStore.getState().bodies;
    const body = bodies.find((item) => item.id === bodyId);
    const bodyCoats = get().coats.filter((coat) => coat.bodyId === bodyId);
    const painted = bodyCoats.some((coat) => isPainted(coat));
    return evaluateGate(body?.code ?? UNKNOWN_CODE, forCoating && painted, {
      bodies,
      blanks: useBlankStore.getState().blanks,
      coats: get().coats,
    });
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
}));

/** 道次派生选择器：按状态集合过滤 */
export function selectCoatsByStates(coats: Coat[], states: CoatState[]): Coat[] {
  if (states.length === 0) return coats;
  return coats.filter((coat) => states.includes(coat.state));
}
