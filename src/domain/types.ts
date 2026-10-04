// 업무 도메인 모델. 보기 설정(view_preferences)과 완전히 분리되어 있다.

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type ProjectStatus = 'active' | 'on_hold' | 'done' | 'archived';

/** 동기화 메타데이터. 없으면 서버에 생성된 적 없는 레코드 */
export interface DomainSyncMeta {
  /** 서버가 확인한 버전 */
  server_version: number;
  /** 마지막으로 서버와 일치했던 동기화 필드 값 (3-way 병합 기준) */
  base: Record<string, unknown>;
}

interface Base {
  id: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** 레코드 버전. 서버와 동기화된 직후에는 서버 버전과 같다 */
  version: number;
  _sync?: DomainSyncMeta;
}

export interface Project extends Base {
  name: string;
  description: string;
  status: ProjectStatus;
}

export interface Category extends Base {
  name: string;
  color: string;
}

export interface Task extends Base {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** 날짜 전용 값 YYYY-MM-DD */
  due_date: string | null;
  project_id: string | null;
  category_id: string | null;
  completed_at: string | null;
}

export interface CalendarEvent extends Base {
  title: string;
  description: string;
  /** 시간대가 있는 시각 (ISO 8601 UTC) */
  start_at: string;
  end_at: string;
  all_day: boolean;
  /** IANA 시간대 */
  timezone: string;
  /** RFC 5545 RRULE 부분집합 (src/domain/recurrence.ts). 예외 회차 행에서는 null */
  recurrence_rule: string | null;
  /** 예외 회차(단일 회차 변경·취소) 행이면 원본 반복 일정 ID */
  recurrence_parent_id: string | null;
  /** 예외 회차가 대체하는 원래 회차의 시작 시각 */
  original_start_at: string | null;
  /** 취소된 회차 */
  is_cancelled: boolean;
  project_id: string | null;
  category_id: string | null;
}

export interface DomainSnapshot {
  tasks: Task[];
  events: CalendarEvent[];
  projects: Project[];
  categories: Category[];
}

export const DOMAIN_STORES = ['tasks', 'events', 'projects', 'categories'] as const;
export type DomainStore = (typeof DOMAIN_STORES)[number];
export type Entity = DomainStore;
export type EntityRecord = Task | CalendarEvent | Project | Category;

/** 동기화 순서: 참조되는 쪽(프로젝트·분류)을 먼저 보낸다 */
export const SYNC_ORDER: Entity[] = ['projects', 'categories', 'events', 'tasks'];

/** 엔티티별 동기화 대상 필드 (서버 domain_sync_fields 와 같아야 함) */
export const ENTITY_FIELDS: Record<Entity, readonly string[]> = {
  projects: ['name', 'description', 'status', 'deleted_at'],
  categories: ['name', 'color', 'deleted_at'],
  tasks: ['title', 'description', 'status', 'priority', 'due_date', 'project_id', 'category_id', 'completed_at', 'deleted_at'],
  events: [
    'title',
    'description',
    'start_at',
    'end_at',
    'all_day',
    'timezone',
    'recurrence_rule',
    'recurrence_parent_id',
    'original_start_at',
    'is_cancelled',
    'project_id',
    'category_id',
    'deleted_at',
  ],
};

/**
 * 병합 단위. 같은 묶음 안의 필드는 서로 의존하므로 한 단위로 비교한다.
 * (예: 시작·종료 시각을 서로 다른 기기 값으로 섞으면 종료가 시작보다 빠를 수 있음)
 */
export const MERGE_GROUPS: Record<Entity, readonly (readonly string[])[]> = {
  projects: [['name'], ['description'], ['status'], ['deleted_at']],
  categories: [['name'], ['color'], ['deleted_at']],
  tasks: [['title'], ['description'], ['status', 'completed_at'], ['priority'], ['due_date'], ['project_id'], ['category_id'], ['deleted_at']],
  events: [
    ['title'],
    ['description'],
    ['start_at', 'end_at', 'all_day', 'timezone', 'recurrence_rule'],
    ['recurrence_parent_id', 'original_start_at'],
    ['is_cancelled'],
    ['project_id'],
    ['category_id'],
    ['deleted_at'],
  ],
};

export const ENTITY_LABEL: Record<Entity, string> = { tasks: '투두', events: '일정', projects: '프로젝트', categories: '분류' };

export function recordLabel(entity: Entity, r: any): string {
  return (entity === 'projects' || entity === 'categories' ? r?.name : r?.title) ?? '';
}

/** v0.3 이전에 저장된 일정에는 예외 회차 필드가 없으므로 기본값을 채운다 */
export function normalizeEvent(e: CalendarEvent): CalendarEvent {
  return {
    ...e,
    recurrence_parent_id: e.recurrence_parent_id ?? null,
    original_start_at: e.original_start_at ?? null,
    is_cancelled: e.is_cancelled ?? false,
  };
}
