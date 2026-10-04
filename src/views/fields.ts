import type { CalendarEvent, Category, DomainSnapshot, Project, Task } from '../domain/types';
import type { ViewDomain } from './types';

export type FieldKind = 'text' | 'enum' | 'date' | 'instant' | 'boolean' | 'number' | 'ref';
export type FilterKind = 'in' | 'dateRange' | 'bool';

export interface EnumOption {
  value: string;
  label: string;
}

export interface FieldContext {
  projects: Map<string, Project>;
  categories: Map<string, Category>;
  projectTaskCounts: Map<string, { total: number; open: number }>;
  projectEventCounts: Map<string, number>;
}

export interface FieldDef<R = any> {
  /** 안정적인 필드 키. 저장되는 식별자 */
  key: string;
  /** 표시 이름. 식별자로 사용하지 않는다 */
  label: string;
  kind: FieldKind;
  /** 레코드 식별 컬럼. 숨길 수 없다 */
  identity?: boolean;
  sortable: boolean;
  filter: FilterKind | null;
  searchable?: boolean;
  defaultVisible: boolean;
  defaultWidth: number;
  /** enum 값 (정렬 순서 = 배열 순서) */
  options?: EnumOption[];
  refTarget?: 'projects' | 'categories';
  get: (record: R, ctx: FieldContext) => string | number | boolean | null;
}

export const NONE_VALUE = '__none__';
export const MIN_WIDTH = 60;
export const MAX_WIDTH = 800;
export const MAX_SORTS = 3;
export const MAX_SEARCH = 200;

export const TASK_STATUS: EnumOption[] = [
  { value: 'todo', label: '할 일' },
  { value: 'in_progress', label: '진행 중' },
  { value: 'done', label: '완료' },
];
export const TASK_PRIORITY: EnumOption[] = [
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' },
  { value: 'high', label: '높음' },
  { value: 'urgent', label: '긴급' },
];
export const PROJECT_STATUS: EnumOption[] = [
  { value: 'active', label: '진행 중' },
  { value: 'on_hold', label: '보류' },
  { value: 'done', label: '완료' },
  { value: 'archived', label: '보관' },
];

const taskFields: FieldDef<Task>[] = [
  { key: 'title', label: '제목', kind: 'text', identity: true, sortable: true, filter: null, searchable: true, defaultVisible: true, defaultWidth: 260, get: (r) => r.title },
  { key: 'description', label: '설명', kind: 'text', sortable: false, filter: null, searchable: true, defaultVisible: false, defaultWidth: 240, get: (r) => r.description || null },
  { key: 'status', label: '상태', kind: 'enum', sortable: true, filter: 'in', defaultVisible: true, defaultWidth: 110, options: TASK_STATUS, get: (r) => r.status },
  { key: 'priority', label: '우선순위', kind: 'enum', sortable: true, filter: 'in', defaultVisible: true, defaultWidth: 110, options: TASK_PRIORITY, get: (r) => r.priority },
  { key: 'due_date', label: '마감일', kind: 'date', sortable: true, filter: 'dateRange', defaultVisible: true, defaultWidth: 130, get: (r) => r.due_date },
  { key: 'project', label: '프로젝트', kind: 'ref', refTarget: 'projects', sortable: true, filter: 'in', defaultVisible: true, defaultWidth: 150, get: (r) => r.project_id },
  { key: 'category', label: '분류', kind: 'ref', refTarget: 'categories', sortable: true, filter: 'in', defaultVisible: true, defaultWidth: 120, get: (r) => r.category_id },
  { key: 'created_at', label: '생성일', kind: 'instant', sortable: true, filter: 'dateRange', defaultVisible: false, defaultWidth: 160, get: (r) => r.created_at },
  { key: 'updated_at', label: '수정일', kind: 'instant', sortable: true, filter: 'dateRange', defaultVisible: false, defaultWidth: 160, get: (r) => r.updated_at },
  { key: 'completed_at', label: '완료일', kind: 'instant', sortable: true, filter: 'dateRange', defaultVisible: false, defaultWidth: 160, get: (r) => r.completed_at },
];

const eventFields: FieldDef<CalendarEvent>[] = [
  { key: 'title', label: '제목', kind: 'text', identity: true, sortable: true, filter: null, searchable: true, defaultVisible: true, defaultWidth: 240, get: (r) => r.title },
  { key: 'description', label: '설명', kind: 'text', sortable: false, filter: null, searchable: true, defaultVisible: false, defaultWidth: 240, get: (r) => r.description || null },
  { key: 'start_at', label: '시작 시각', kind: 'instant', sortable: true, filter: 'dateRange', defaultVisible: true, defaultWidth: 170, get: (r) => r.start_at },
  { key: 'end_at', label: '종료 시각', kind: 'instant', sortable: true, filter: 'dateRange', defaultVisible: true, defaultWidth: 170, get: (r) => r.end_at },
  { key: 'all_day', label: '종일', kind: 'boolean', sortable: true, filter: 'bool', defaultVisible: true, defaultWidth: 80, get: (r) => r.all_day },
  { key: 'timezone', label: '시간대', kind: 'text', sortable: true, filter: null, defaultVisible: false, defaultWidth: 140, get: (r) => r.timezone },
  { key: 'recurring', label: '반복', kind: 'boolean', sortable: true, filter: 'bool', defaultVisible: true, defaultWidth: 80, get: (r) => !!r.recurrence_rule },
  { key: 'project', label: '프로젝트', kind: 'ref', refTarget: 'projects', sortable: true, filter: 'in', defaultVisible: true, defaultWidth: 150, get: (r) => r.project_id },
  { key: 'category', label: '분류', kind: 'ref', refTarget: 'categories', sortable: true, filter: 'in', defaultVisible: true, defaultWidth: 120, get: (r) => r.category_id },
  { key: 'updated_at', label: '수정일', kind: 'instant', sortable: true, filter: 'dateRange', defaultVisible: false, defaultWidth: 160, get: (r) => r.updated_at },
];

const projectFields: FieldDef<Project>[] = [
  { key: 'name', label: '이름', kind: 'text', identity: true, sortable: true, filter: null, searchable: true, defaultVisible: true, defaultWidth: 240, get: (r) => r.name },
  { key: 'description', label: '설명', kind: 'text', sortable: false, filter: null, searchable: true, defaultVisible: true, defaultWidth: 260, get: (r) => r.description || null },
  { key: 'status', label: '상태', kind: 'enum', sortable: true, filter: 'in', defaultVisible: true, defaultWidth: 110, options: PROJECT_STATUS, get: (r) => r.status },
  { key: 'created_at', label: '생성일', kind: 'instant', sortable: true, filter: 'dateRange', defaultVisible: false, defaultWidth: 160, get: (r) => r.created_at },
  { key: 'updated_at', label: '수정일', kind: 'instant', sortable: true, filter: 'dateRange', defaultVisible: true, defaultWidth: 160, get: (r) => r.updated_at },
  { key: 'task_count', label: '작업 수', kind: 'number', sortable: true, filter: null, defaultVisible: true, defaultWidth: 90, get: (r, c) => c.projectTaskCounts.get(r.id)?.total ?? 0 },
  { key: 'open_task_count', label: '미완료 작업', kind: 'number', sortable: true, filter: null, defaultVisible: true, defaultWidth: 110, get: (r, c) => c.projectTaskCounts.get(r.id)?.open ?? 0 },
  { key: 'event_count', label: '일정 수', kind: 'number', sortable: true, filter: null, defaultVisible: false, defaultWidth: 90, get: (r, c) => c.projectEventCounts.get(r.id) ?? 0 },
];

export const FIELD_REGISTRY: Record<ViewDomain, FieldDef[]> = {
  tasks: taskFields,
  events: eventFields,
  projects: projectFields,
};

export const DOMAIN_LABEL: Record<ViewDomain, string> = { tasks: '투두', events: '캘린더 일정', projects: '프로젝트' };

export function getField(domain: ViewDomain, key: string): FieldDef | undefined {
  return FIELD_REGISTRY[domain].find((f) => f.key === key);
}

export function domainRecords(domain: ViewDomain, data: DomainSnapshot): any[] {
  // 일정 테이블에는 일정(반복 일정은 원본 1행)만 보이고, 회차별 변경 행은 회차 목록에서 다룬다.
  return domain === 'tasks' ? data.tasks : domain === 'events' ? data.events.filter((e) => !e.recurrence_parent_id) : data.projects;
}

export function buildContext(data: DomainSnapshot): FieldContext {
  const projectTaskCounts = new Map<string, { total: number; open: number }>();
  for (const t of data.tasks) {
    if (!t.project_id) continue;
    const c = projectTaskCounts.get(t.project_id) ?? { total: 0, open: 0 };
    c.total++;
    if (t.status !== 'done') c.open++;
    projectTaskCounts.set(t.project_id, c);
  }
  const projectEventCounts = new Map<string, number>();
  for (const e of data.events) {
    if (e.project_id) projectEventCounts.set(e.project_id, (projectEventCounts.get(e.project_id) ?? 0) + 1);
  }
  return {
    projects: new Map(data.projects.map((p) => [p.id, p])),
    categories: new Map(data.categories.map((c) => [c.id, c])),
    projectTaskCounts,
    projectEventCounts,
  };
}
