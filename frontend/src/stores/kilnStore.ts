/**
 * 制胎间状态管理（Zustand）
 * 管坯胎入库单（KilnReceipt）与含水率复测（MoistureTest），并负责驱动两头对账：
 * - 制胎间这头的写入与髹涂那头解耦：这头写失败只退这头重试，另一头照旧；
 * - 对账（挂起表 + 道次压排）作为写后独立同步步骤，失败不回滚业务写入。
 */
import { create } from 'zustand';
import { createId, db } from '@/utils/db';
import type { KilnReceipt, KilnReceiptDraft, MoistureTest, MoistureTestDraft } from '@/types/kiln';
import type { Reconciliation } from '@/types/reconcile';
import { useBodyStore } from './bodyStore';
import { useCoatStore } from './coatStore';
import { latestTestOf, reconcileAll } from '@/utils/reconcile';

/** 制胎间写入结果：让调用方知道是哪一头失败、该不该只重试这一头 */
export interface KilnWriteResult {
  ok: boolean;
  error: string;
}

interface KilnStoreState {
  receipts: KilnReceipt[];
  tests: MoistureTest[];
  holds: Reconciliation[];
  loading: boolean;
  ready: boolean;
  error: string;
  /** 对账单独标记：对账失败不影响入库单 / 复测读取 */
  reconcileError: string;

  loadKiln: () => Promise<void>;
  createReceipt: (draft: KilnReceiptDraft) => Promise<KilnWriteResult>;
  updateReceipt: (id: string, patch: Partial<KilnReceipt>) => Promise<KilnWriteResult>;
  removeReceipt: (id: string) => Promise<KilnWriteResult>;
  createTest: (draft: MoistureTestDraft) => Promise<KilnWriteResult>;
  updateTest: (id: string, patch: Partial<MoistureTest>) => Promise<KilnWriteResult>;
  removeTest: (id: string) => Promise<KilnWriteResult>;
  /** 人工判定挂起 */
  resolveHold: (issueKey: string, resolver: string, note: string) => Promise<KilnWriteResult>;
  /** 重跑对账（只重试对账这一头） */
  runReconcile: () => Promise<KilnWriteResult>;

  receiptOfCode: (code: string) => KilnReceipt | undefined;
  testsOfCode: (code: string) => MoistureTest[];
  latestTestOfCode: (code: string) => MoistureTest | undefined;
}

export const useKilnStore = create<KilnStoreState>((set, get) => ({
  receipts: [],
  tests: [],
  holds: [],
  loading: false,
  ready: false,
  error: '',
  reconcileError: '',

  async loadKiln() {
    set({ loading: true });
    try {
      const [receipts, tests, holds] = await Promise.all([
        db.kilnReceipts.orderBy('updatedAt').reverse().toArray(),
        db.moistureTests.orderBy('updatedAt').reverse().toArray(),
        db.reconciliations.orderBy('updatedAt').reverse().toArray(),
      ]);
      set({ receipts, tests, holds, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '制胎间数据读取失败' });
    }
  },

  async createReceipt(draft) {
    // 只写制胎间这一头；失败仅返回这一头的错误，不触碰髹涂那头
    try {
      const now = Date.now();
      const row: KilnReceipt = { ...draft, id: createId('receipt'), createdAt: now, updatedAt: now };
      await db.kilnReceipts.put(row);
      await get().loadKiln();
      await get().runReconcile();
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '入库单写入失败，请重试' };
    }
  },

  async updateReceipt(id, patch) {
    try {
      const prev = get().receipts.find((item) => item.id === id);
      await db.kilnReceipts.update(id, { ...patch, updatedAt: Date.now() });
      // 编号改了：把这具坯胎的复测记录编号一并带过去，保持两边对账键一致
      if (patch.code && prev && patch.code.trim() !== prev.code) {
        const linked = await db.moistureTests.where('receiptId').equals(id).toArray();
        if (linked.length > 0) {
          const now = Date.now();
          await db.moistureTests.bulkPut(
            linked.map((test) => ({ ...test, code: patch.code!.trim(), updatedAt: now })),
          );
        }
      }
      await get().loadKiln();
      await get().runReconcile();
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '入库单更新失败，请重试' };
    }
  },

  async removeReceipt(id) {
    try {
      // 仅级联制胎间自身的复测记录与编号对不上挂起；髹涂那头的胎体 / 道次照旧
      await db.transaction('rw', [db.kilnReceipts, db.moistureTests, db.reconciliations], async () => {
        await db.moistureTests.where('receiptId').equals(id).delete();
        await db.reconciliations.where('receiptId').equals(id).delete();
        await db.kilnReceipts.delete(id);
      });
      await get().loadKiln();
      await get().runReconcile();
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '入库单删除失败，请重试' };
    }
  },

  async createTest(draft) {
    try {
      const now = Date.now();
      const row: MoistureTest = { ...draft, id: createId('test'), createdAt: now, updatedAt: now };
      await db.moistureTests.put(row);
      await get().loadKiln();
      await get().runReconcile();
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '复测记录写入失败，请重试' };
    }
  },

  async updateTest(id, patch) {
    try {
      await db.moistureTests.update(id, { ...patch, updatedAt: Date.now() });
      await get().loadKiln();
      await get().runReconcile();
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '复测记录更新失败，请重试' };
    }
  },

  async removeTest(id) {
    try {
      await db.moistureTests.delete(id);
      await get().loadKiln();
      await get().runReconcile();
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '复测记录删除失败，请重试' };
    }
  },

  async resolveHold(issueKey, resolver, note) {
    try {
      const hold = get().holds.find((item) => item.issueKey === issueKey);
      if (!hold) return { ok: false, error: '挂起记录已不存在，请重新对账' };
      await db.reconciliations.put({
        ...hold,
        status: 'resolved',
        resolver: resolver.trim() || '未署名',
        resolveNote: note.trim(),
        updatedAt: Date.now(),
      });
      await get().loadKiln();
      // 判定放行后重跑：压排的待涂道次按最新闸门放回（已上漆的本就不压）
      await get().runReconcile();
      return { ok: true, error: '' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '判定写入失败，请重试' };
    }
  },

  async runReconcile() {
    try {
      const bodies = useBodyStore.getState().bodies;
      const coats = useCoatStore.getState().coats;
      const { receipts, tests, holds } = get();
      const result = reconcileAll(bodies, coats, receipts, tests, holds);

      // 对账挂起落库（独立于业务写入）
      await db.transaction('rw', [db.reconciliations, db.coats], async () => {
        if (result.upserts.length > 0) await db.reconciliations.bulkPut(result.upserts);
        if (result.removeKeys.length > 0) await db.reconciliations.bulkDelete(result.removeKeys);

        // 道次压排：仅翻转待涂道次的 held；上了漆的道次不退回
        const now = Date.now();
        const flips = coats
          .filter((coat) => coat.state === 'todo' && coat.held !== result.heldCoatIds.has(coat.id))
          .map((coat) => ({ ...coat, held: result.heldCoatIds.has(coat.id), updatedAt: now }));
        if (flips.length > 0) await db.coats.bulkPut(flips);
      });

      if (result.removeKeys.length > 0 || result.upserts.some((hold) => !holds.some((old) => old.issueKey === hold.issueKey))) {
        await get().loadKiln();
      } else {
        set({ holds: await db.reconciliations.orderBy('updatedAt').reverse().toArray() });
      }
      // 道次 held 可能被改，通知髹涂那头重读；那头自己的状态 / 顺序不变
      await useCoatStore.getState().loadCoats();
      set({ reconcileError: '' });
      return { ok: true, error: '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : '对账失败，可重试';
      set({ reconcileError: message });
      return { ok: false, error: message };
    }
  },

  receiptOfCode(code) {
    return get().receipts.find((receipt) => receipt.code === code);
  },

  testsOfCode(code) {
    return get()
      .tests.filter((test) => test.code === code)
      .sort((a, b) => (a.testDate === b.testDate ? b.createdAt - a.createdAt : a.testDate < b.testDate ? 1 : -1));
  },

  latestTestOfCode(code) {
    return latestTestOf(code, get().tests);
  },
}));
