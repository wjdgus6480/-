import type { StoreNames } from 'idb';
import type { DB, DotdayDB } from '../db/idb';
import { SYNC_ORDER } from '../domain/types';

/**
 * 이 기기(IndexedDB `dotday`)에 남은 데이터 관리.
 * - "이 기기 데이터 지우기"(clearDeviceData)는 서버 계정·데이터를 건드리지 않는다. 회원 탈퇴와 다른 동작이다.
 * - 서버로 아직 보내지 않은 변경, 서버에 없는 로그인 전 데이터가 있으면 기본적으로 지우지 않는다(유실 방지).
 * - DB 버전·스토어 구조는 바꾸지 않는다. 스토어를 비우기만 한다.
 */

type StoreName = StoreNames<DotdayDB>;
const ALL_STORES: StoreName[] = [
  'tasks', 'events', 'projects', 'categories',
  'view_preferences', 'view_outbox', 'view_conflicts', 'view_backups',
  'domain_outbox', 'domain_conflicts', 'domain_backups', 'meta',
];

export interface DeviceDataSummary {
  /** 업무 레코드 수 (삭제 표시 포함) */
  records: number;
  /** 로그인 전(게스트) 데이터(삭제되지 않은 것): 서버에 사본이 없음 */
  guestRecords: number;
  /** 다른 계정 데이터 (현재 계정이 아닌 owner) */
  otherAccountRecords: number;
  /** 아직 서버로 보내지 않은 변경 (업무 + 보기 설정, 전송 실패·충돌 포함) */
  unsent: number;
  /** 확인이 필요한 충돌 */
  conflicts: number;
}

export async function summarizeDeviceData(db: DB, currentOwner: string | null): Promise<DeviceDataSummary> {
  let records = 0;
  let guestRecords = 0;
  let otherAccountRecords = 0;
  for (const e of SYNC_ORDER) {
    for (const r of await db.getAll(e)) {
      records++;
      const owner = r.owner_id ?? null;
      if (owner === null) guestRecords += r.deleted_at ? 0 : 1;
      else if (owner !== currentOwner) otherAccountRecords++;
    }
  }
  const guestViews = (await db.getAll('view_preferences')).filter((v) => v.owner_id === null && !v.deleted_at).length;
  const unsent = (await db.count('domain_outbox')) + (await db.count('view_outbox'));
  const conflicts = (await db.count('domain_conflicts')) + (await db.count('view_conflicts'));
  return { records, guestRecords: guestRecords + guestViews, otherAccountRecords, unsent, conflicts };
}

export type ClearResult = { ok: true } | { ok: false; reason: 'unsent'; summary: DeviceDataSummary };

/**
 * 이 기기의 DOTDAY 데이터를 모두 지운다 (공용 PC 등).
 * 미전송 변경·로그인 전 데이터가 있으면 acceptLoss 없이는 지우지 않는다.
 * 지운 뒤에는 앱을 새로 고쳐야 한다(메모리의 프로필 ID·동기화 상태 초기화).
 */
export async function clearDeviceData(db: DB, opts: { currentOwner: string | null; acceptLoss?: boolean }): Promise<ClearResult> {
  const summary = await summarizeDeviceData(db, opts.currentOwner);
  if (!opts.acceptLoss && (summary.unsent > 0 || summary.guestRecords > 0 || summary.conflicts > 0)) return { ok: false, reason: 'unsent', summary };
  const tx = db.transaction(ALL_STORES, 'readwrite');
  await Promise.all([...ALL_STORES.map((s) => tx.objectStore(s).clear()), tx.done]);
  clearDotdayLocalStorage();
  return { ok: true };
}

/**
 * 탈퇴한 계정의 데이터만 이 기기에서 지운다 (같은 기기의 로그인 전 데이터·다른 계정 데이터는 보존).
 * 탈퇴한 계정의 미전송 변경은 보낼 곳이 없으므로 함께 지운다.
 */
export async function purgeOwnerData(db: DB, owner: string): Promise<{ removed: number }> {
  let removed = 0;
  const stores: StoreName[] = ['tasks', 'events', 'projects', 'categories', 'view_preferences', 'view_outbox', 'view_conflicts', 'view_backups', 'domain_outbox', 'domain_conflicts', 'domain_backups', 'meta'];
  const tx = db.transaction(stores, 'readwrite');
  const ownedIds = new Set<string>();
  for (const e of SYNC_ORDER) {
    const s = tx.objectStore(e);
    for (const r of await s.getAll()) {
      if (r.owner_id === owner) {
        ownedIds.add(`${e}:${r.id}`);
        await s.delete(r.id);
        removed++;
      }
    }
  }
  const viewIds = new Set<string>();
  for (const v of await tx.objectStore('view_preferences').getAll()) {
    if (v.owner_id === owner) {
      viewIds.add(v.id);
      await tx.objectStore('view_preferences').delete(v.id);
      removed++;
    }
  }
  for (const op of await tx.objectStore('domain_outbox').getAll()) if (ownedIds.has(op.key)) await tx.objectStore('domain_outbox').delete(op.op_id);
  for (const op of await tx.objectStore('view_outbox').getAll()) if (viewIds.has(op.view_id)) await tx.objectStore('view_outbox').delete(op.op_id);
  for (const c of await tx.objectStore('domain_conflicts').getAll()) if (ownedIds.has(`${c.entity}:${c.record_id}`)) await tx.objectStore('domain_conflicts').delete(c.id);
  for (const c of await tx.objectStore('view_conflicts').getAll()) if (viewIds.has(c.view_id)) await tx.objectStore('view_conflicts').delete(c.id);
  for (const b of await tx.objectStore('domain_backups').getAll()) if (b.owner_id === owner) await tx.objectStore('domain_backups').delete(b.id);
  for (const b of await tx.objectStore('view_backups').getAll()) if (b.owner_id === owner) await tx.objectStore('view_backups').delete(b.id);
  // 동기화 커서·이전 계획 등 계정별 메타
  for (const m of await tx.objectStore('meta').getAll()) if (m.key.endsWith(`:${owner}`) || m.key.includes(`:${owner}:`)) await tx.objectStore('meta').delete(m.key);
  await tx.done;
  return { removed };
}

/** 화면 편의 설정(마지막으로 연 보기 등)만 지운다. 로그인 세션(토큰)은 로그아웃으로 지운다. */
function clearDotdayLocalStorage() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('dotday')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* 저장소 접근 불가 → 무시 */
  }
}
