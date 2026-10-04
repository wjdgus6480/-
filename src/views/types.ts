// 보기 설정 타입. 업무 데이터 모델과 분리된 화면 설정만 담는다.

export const VIEW_DOMAINS = ['tasks', 'events', 'projects'] as const;
export type ViewDomain = (typeof VIEW_DOMAINS)[number];

export interface ColumnConfig {
  /** 레지스트리의 안정적인 필드 키 (표시 이름이 아님) */
  field: string;
  visible: boolean;
  position: number;
  width: number;
  /** 왼쪽 고정. 모바일에서는 첫 번째 고정 컬럼만 고정된다. */
  pinned: boolean;
}

export type SortDir = 'asc' | 'desc';
export interface SortRule {
  field: string;
  dir: SortDir;
}

/** 값 목록 일치 (상태·우선순위·프로젝트·분류). 참조 필드는 NONE_VALUE 로 '없음'을 표현한다. */
export interface InCondition {
  type: 'in';
  field: string;
  values: string[];
}
/** 날짜 범위(양 끝 포함). from/to 는 YYYY-MM-DD.
 * 날짜 전용 필드는 그대로 비교하고, 시각 필드는 tz 기준 달력 날짜로 변환해 비교한다. */
export interface DateRangeCondition {
  type: 'dateRange';
  field: string;
  from: string | null;
  to: string | null;
  tz?: string;
}
export interface BoolCondition {
  type: 'bool';
  field: string;
  value: boolean;
}
export type FilterCondition = InCondition | DateRangeCondition | BoolCondition;

export interface FilterConfig {
  search: string;
  conditions: FilterCondition[];
}

export interface LayoutConfig {
  density: 'comfortable' | 'compact';
  /** 표시용 시간대 */
  timezone?: string;
}

export interface ViewConfig {
  column_config: ColumnConfig[];
  sort_config: SortRule[];
  filter_config: FilterConfig;
  layout_config: LayoutConfig;
}

export interface ViewPreference extends ViewConfig {
  id: string;
  /** 로그인 전에는 null. 서버 소유권을 임의로 부여하지 않는다. */
  owner_id: string | null;
  local_profile_id: string;
  view_key: ViewDomain;
  name: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** 서버가 확인한 버전. 0 = 아직 서버에 없음 */
  version: number;
}

/** 동기화 대상 필드 (충돌 비교 단위) */
export const SYNC_FIELDS = ['name', 'column_config', 'sort_config', 'filter_config', 'layout_config', 'is_default', 'deleted_at'] as const;
export type SyncField = (typeof SYNC_FIELDS)[number];
export type SyncedFields = Pick<ViewPreference, SyncField>;

export interface LocalViewRecord extends ViewPreference {
  _sync: {
    /** 마지막으로 서버와 일치했던 값. null = 서버에 생성된 적 없음 */
    base: SyncedFields | null;
  };
}

/** pending: 전송 대기, inflight: 전송 중(중단 시 같은 op_id 로 재전송), conflict: 사용자 확인 필요, rejected: 서버가 영구 거부 */
export type OutboxStatus = 'pending' | 'inflight' | 'conflict' | 'rejected';
export interface OutboxOp {
  op_id: string;
  view_id: string;
  /** 변경된 필드 목록. 값은 전송 시점의 로컬 레코드에서 읽는다. */
  fields: SyncField[];
  status: OutboxStatus;
  seq: number;
  created_at: string;
  attempts: number;
  last_error?: string;
}

export interface ConflictField {
  field: SyncField;
  base: unknown;
  local: unknown;
  remote: unknown;
}
export interface ViewConflict {
  id: string;
  view_id: string;
  op_id: string;
  view_name: string;
  fields: ConflictField[];
  /** 충돌 없이 자동 병합된 로컬 변경 필드 */
  merged_fields: SyncField[];
  remote_row: RemoteViewRow;
  created_at: string;
}

export interface ViewBackup {
  id: string;
  reason: 'import' | 'migration' | 'manual';
  created_at: string;
  owner_id: string | null;
  views: ViewPreference[];
}

/** 서버 행 */
export interface RemoteViewRow {
  id: string;
  owner_id: string;
  local_profile_id: string | null;
  view_key: ViewDomain;
  name: string;
  column_config: ColumnConfig[];
  sort_config: SortRule[];
  filter_config: FilterConfig;
  layout_config: LayoutConfig;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  server_seq: number;
}

// ---- 오류 계약 ----

export type ViewErrorCode =
  | 'VALIDATION'
  | 'UNKNOWN_DOMAIN'
  | 'NOT_FOUND'
  | 'LAST_VIEW'
  | 'CONFLICT_NOT_FOUND'
  | 'INVALID_RESOLUTION'
  | 'NOT_AUTHENTICATED'
  | 'REMOTE_UNAVAILABLE'
  | 'IMPORT_INVALID'
  | 'STORAGE';

export interface ValidationIssue {
  code:
    | 'INVALID_TYPE'
    | 'UNKNOWN_FIELD'
    | 'DUPLICATE_FIELD'
    | 'DUPLICATE_POSITION'
    | 'INVALID_POSITION'
    | 'INVALID_WIDTH'
    | 'IDENTITY_COLUMN_HIDDEN'
    | 'INVALID_SORT_DIRECTION'
    | 'FIELD_NOT_SORTABLE'
    | 'TOO_MANY_SORTS'
    | 'INVALID_FILTER_TYPE'
    | 'FIELD_NOT_FILTERABLE'
    | 'INVALID_FILTER_VALUE'
    | 'INVALID_DATE'
    | 'INVALID_TIMEZONE'
    | 'INVALID_NAME'
    | 'UNKNOWN_KEY';
  path: string;
  message: string;
}

export interface ViewError {
  code: ViewErrorCode;
  message: string;
  issues?: ValidationIssue[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ViewError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(code: ViewErrorCode, message: string, issues?: ValidationIssue[]): Result<T> => ({
  ok: false,
  error: { code, message, ...(issues ? { issues } : {}) },
});
