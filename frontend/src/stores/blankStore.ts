/**
 * 制胎间状态管理（Zustand）
 * 管坯胎入库单（blanks）与含水率复测（retests）。
 * - 复测登记：写复测记录为本头，回写入库单最近结论为另一头，各自独立 try/catch
 * - 复测未达标的压着等，复测过了再放回可编排
 * - 复测结论 / 编号对不上的挂起等人判；上了漆的不退回
 * - 转入髹涂台：本头先建胎体（带幂等保护），再回写入库单对账关系，一头失败只退这一（头）步重试
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Blank, BlankDraft, BlankStatus } from '@/types/blank';
import type { MoistureRetest, MoistureRetestDraft } from '@/types/retest';
import { isMoistureConsistent } from '@/utils/moisture';
import { isPainted, latestRetestOf, reconcileAll, recomputeBlankStatus } from '@/utils/reconcile';
import type { Body } from '@/types/body';

/** 单侧写入结果：失败只退这一（头）步重试，另一头照旧 */
export interface SideWriteOutcome {
  ok: boolean;
  /** 失败时的错误文案，调用方据此只重试这一头 */
  error: string;
}

export interface AdmitResult {
  /** 第一头：髹涂台胎体是否落库 */
  body: SideWriteOutcome;
  /** 第二头：入库单对账状态是否回写 */
  blank: SideWriteOutcome;
  bodyId?: string;
}

interface BlankStoreState {
  blanks: Blank[];
  retests: MoistureRetest[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadBlanks: () => Promise<void>;
  loadRetests: () => Promise<void>;
  retestsOf: (blankId: string) => MoistureRetest[];
  createBlank: (draft: BlankDraft) => Promise<Blank>;
  updateBlank: (id: string, patch: Partial<Blank>) => Promise<void>;
  removeBlank: (id: string) => Promise<void>;
  /** 登记一次复测：写复测（本头）+ 回写入库单最近结论与状态（另一头），两头独立成败 */
  addRetest: (draft: MoistureRetestDraft) => Promise<{ retest: SideWriteOutcome; blank: SideWriteOutcome }>;
  removeRetest: (id: string) => Promise<void>;
  /**
   * 复测达标入库单转入髹涂台：
   * 第一头按编号建胎体（已有同编号胎体则幂等复用），第二头回写入库单为已对账。
   * 任一头失败只返回该头错误，另一头已落库的数据照旧，重试不重复建单。
   */
  admitToFloor: (blankId: string) => Promise<AdmitResult>;
  /** 人工判定「复测结论对不上」：以复测表读数重新判定，结论以读数为准 */
  resolveRetestHold: (blankId: string) => Promise<SideWriteOutcome>;
  /** 人工判定「编号对不上」：把道次改挂到正确坯胎编号的胎体名下，解除挂起 */
  resolveCodeHold: (blankId: string, targetBodyId: string) => Promise<SideWriteOutcome>;
  /** 给髹涂台查无入库单的胎体补开入库单（以该胎体编号），并带一条合格复测 */
  backfillBlankForBody: (bodyId: string) => Promise<SideWriteOutcome>;
  /** 重新跑一遍两头对账（编号 + 复测结论） */
  reconcile: () => Promise<{ changed: number; errors: string[] }>;
}

async function persistBlankFromRetest(blankId: string): Promise<void> {
  const [blank, bodies, coats] = await Promise.all([
    db.blanks.get(blankId),
    db.bodies.toArray(),
    db.coats.toArray(),
  ]);
  if (!blank) throw new Error('入库单不存在');
  const latest = await latestRetestOf(blankId);
  const next = recomputeBlankStatus(blank, { bodies, coats, latest });
  await db.blanks.put({
    ...blank,
    status: next.status,
    holdReason: next.holdReason,
    matchedBodyId: next.matchedBodyId,
    lastRetestResult: latest?.result ?? null,
    lastMoisturePct: latest?.moisturePct ?? null,
    lastRetestDate: latest?.date ?? null,
    updatedAt: Date.now(),
  });
}

export const useBlankStore = create<BlankStoreState>((set, get) => ({
  blanks: [],
  retests: [],
  loading: false,
  ready: false,
  error: '',

  async loadBlanks() {
    set({ loading: true });
    try {
      const blanks = await db.blanks.orderBy('updatedAt').reverse().toArray();
      set({ blanks, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '坯胎入库单读取失败' });
    }
  },

  async loadRetests() {
    try {
      const retests = await db.retests.toArray();
      retests.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1));
      set({ retests, error: '' });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '复测记录读取失败' });
    }
  },

  retestsOf(blankId) {
    return get()
      .retests.filter((row) => row.blankId === blankId)
      .sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1));
  },

  async createBlank(draft) {
    const now = Date.now();
    const row: Blank = {
      ...draft,
      id: createId('blank'),
      status: 'inStock',
      holdReason: '',
      lastRetestResult: null,
      lastMoisturePct: null,
      lastRetestDate: null,
      matchedBodyId: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.blanks.put(row);
    await get().loadBlanks();
    return row;
  },

  async updateBlank(id, patch) {
    await db.blanks.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadBlanks();
  },

  async removeBlank(id) {
    await db.retests.where('blankId').equals(id).delete();
    await db.blanks.delete(id);
    await Promise.all([get().loadBlanks(), get().loadRetests()]);
  },

  async addRetest(draft) {
    // 第一头：写复测记录（制胎间本头）
    let retestOutcome: SideWriteOutcome = { ok: true, error: '' };
    const now = Date.now();
    const row: MoistureRetest = { ...draft, id: createId('retest'), createdAt: now, updatedAt: now };
    try {
      await db.retests.put(row);
    } catch (error) {
      retestOutcome = { ok: false, error: error instanceof Error ? error.message : '复测记录写入失败' };
    }

    // 第二头：回写入库单最近复测结论并重算状态；第一头失败时这头照旧不做
    let blankOutcome: SideWriteOutcome = { ok: true, error: '' };
    if (retestOutcome.ok) {
      try {
        await persistBlankFromRetest(draft.blankId);
      } catch (error) {
        // 复测已落库，只是入库单回写失败：只退这一（头）步重试
        blankOutcome = { ok: false, error: error instanceof Error ? error.message : '入库单回写失败' };
      }
    } else {
      blankOutcome = { ok: false, error: '复测记录未落库，入库单未回写' };
    }

    await Promise.all([get().loadRetests(), get().loadBlanks()]);
    return { retest: retestOutcome, blank: blankOutcome };
  },

  async removeRetest(id) {
    const target = get().retests.find((row) => row.id === id);
    await db.retests.delete(id);
    if (target) {
      try {
        await persistBlankFromRetest(target.blankId);
      } catch {
        /* 删除已成功，入库单回写失败不阻断；下次登记复测或手动对账时会修正 */
      }
    }
    await Promise.all([get().loadRetests(), get().loadBlanks()]);
  },

  async admitToFloor(blankId) {
    const blank = get().blanks.find((item) => item.id === blankId);
    const result: AdmitResult = {
      body: { ok: false, error: '' },
      blank: { ok: false, error: '' },
    };
    if (!blank) {
      result.body.error = '入库单不存在';
      return result;
    }
    if (blank.status !== 'ready') {
      result.body.error = '仅复测达标的在库坯胎可转入髹涂台';
      return result;
    }

    // 第一头：髹涂台按坯胎编号建胎体；同编号胎体已存在则幂等复用（重试不重复建单）
    let bodyId = '';
    try {
      const existing = await db.bodies.where('code').equals(blank.code).first();
      if (existing) {
        bodyId = existing.id;
      } else {
        const now = Date.now();
        const body: Body = {
          id: createId('body'),
          code: blank.code,
          material: blank.material,
          shape: blank.shape,
          sizeMm: blank.sizeMm,
          ownerName: '',
          state: 'pending',
          createdAt: now,
          updatedAt: now,
        };
        await db.bodies.put(body);
        bodyId = body.id;
      }
      result.body = { ok: true, error: '' };
      result.bodyId = bodyId;
    } catch (error) {
      // 第一头失败：第二头不动，只重试转入即可
      result.body = { ok: false, error: error instanceof Error ? error.message : '髹涂台建档失败' };
      return result;
    }

    // 第二头：回写入库单对账关系与状态（已上漆则 onFloor，否则 ready 等排道次）
    try {
      const coats = await db.coats.where('bodyId').equals(bodyId).toArray();
      const painted = coats.some((coat) => isPainted(coat));
      const status: BlankStatus = painted ? 'onFloor' : 'ready';
      await db.blanks.update(blankId, {
        matchedBodyId: bodyId,
        status,
        holdReason: '',
        updatedAt: Date.now(),
      } as never);
      result.blank = { ok: true, error: '' };
    } catch (error) {
      // 第二头失败：胎体已在髹涂台那头落库，照旧保留；只需重试回写
      result.blank = { ok: false, error: error instanceof Error ? error.message : '入库单回写失败，胎体已建档' };
    }

    await get().loadBlanks();
    return result;
  },

  async resolveRetestHold(blankId) {
    // 人工判定：读数与结论矛盾时，以读数重新判定，改写最近一条复测的结论后重算
    try {
      const latest = await latestRetestOf(blankId);
      if (!latest) throw new Error('该坯胎没有复测记录');
      const verdict = isMoistureConsistent(latest.moisturePct, 'pass') ? 'pass' : 'fail';
      if (latest.result !== verdict) {
        await db.retests.update(latest.id, { result: verdict, updatedAt: Date.now() } as never);
      }
      await persistBlankFromRetest(blankId);
      await Promise.all([get().loadRetests(), get().loadBlanks()]);
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '判定失败，请重试' };
    }
  },

  async resolveCodeHold(blankId, targetBodyId) {
    // 人工判定编号归属：把盗用该编号的道次改挂到正确胎体名下，并校正编号快照
    try {
      const blank = await db.blanks.get(blankId);
      if (!blank) throw new Error('入库单不存在');
      const [target, allCoats] = await Promise.all([db.bodies.get(targetBodyId), db.coats.toArray()]);
      if (!target) throw new Error('目标胎体不存在');
      const stray = allCoats.filter((coat) => coat.bodyCode === blank.code);
      const now = Date.now();
      // 编号确属该坯胎：道次归到同编号胎体，并把快照统一为坯胎编号
      await db.coats.bulkPut(
        stray.map((coat) => ({ ...coat, bodyId: targetBodyId, bodyCode: target.code, updatedAt: now })),
      );
      await db.blanks.update(blankId, {
        matchedBodyId: targetBodyId,
        status: target.code === blank.code ? 'ready' : 'held',
        holdReason: target.code === blank.code ? '' : `坯胎编号 ${blank.code} 与胎体编号 ${target.code} 仍不一致`,
        updatedAt: now,
      } as never);
      await get().loadBlanks();
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '编号归属调整失败，请重试' };
    }
  },

  async backfillBlankForBody(bodyId) {
    // 髹涂台先建了胎体、制胎间查无入库单：补开入库单 + 一条合格复测（标旧档补开）
    try {
      const body = await db.bodies.get(bodyId);
      if (!body) throw new Error('胎体不存在');
      const duplicated = await db.blanks.where('code').equals(body.code).first();
      if (duplicated) throw new Error(`编号 ${body.code} 的入库单已存在`);
      const now = Date.now();
      const blankId = createId('blank');
      const blank: Blank = {
        id: blankId,
        code: body.code,
        material: body.material,
        shape: body.shape,
        sizeMm: body.sizeMm,
        maker: '补开入库单',
        madeDate: new Date(body.createdAt).toISOString().slice(0, 10),
        initialMoisturePct: 0,
        status: 'ready',
        holdReason: '',
        lastRetestResult: 'pass',
        lastMoisturePct: null,
        lastRetestDate: new Date().toISOString().slice(0, 10),
        matchedBodyId: body.id,
        createdAt: now,
        updatedAt: now,
      };
      const retest: MoistureRetest = {
        id: createId('retest'),
        blankId,
        date: new Date().toISOString().slice(0, 10),
        moisturePct: 0,
        result: 'pass',
        tester: '人工补录',
        note: '髹涂台先建档，制胎间补开入库单并追认放行',
        createdAt: now,
        updatedAt: now,
      };
      await db.blanks.put(blank);
      await db.retests.put(retest);
      // 道次编号快照统一回填
      const coats = await db.coats.where('bodyId').equals(bodyId).toArray();
      if (coats.length > 0) {
        await db.coats.bulkPut(coats.map((coat) => ({ ...coat, bodyCode: body.code, updatedAt: now })));
      }
      await Promise.all([get().loadBlanks(), get().loadRetests()]);
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '补开入库单失败，请重试' };
    }
  },

  async reconcile() {
    const report = await reconcileAll();
    await get().loadBlanks();
    return { changed: report.changed, errors: report.errors };
  },
}));

/** 列表派生：按状态集合筛选入库单 */
export function selectBlanksByStatus(blanks: Blank[], statuses: BlankStatus[]): Blank[] {
  if (statuses.length === 0) return blanks;
  return blanks.filter((blank) => statuses.includes(blank.status));
}
