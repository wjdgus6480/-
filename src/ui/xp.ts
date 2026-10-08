import type { DomainRepository } from '../domain/repo';
import type { Task, TaskPriority } from '../domain/types';

/**
 * EXP·레벨 (Stitch 시안의 '퀘스트' 표현). 저장하지 않고 완료한 투두에서 매번 계산한다
 * → DB·서버·동기화 변경 없이 모든 기기에서 같은 값이 나온다.
 */
export const XP_BY_PRIORITY: Record<TaskPriority, number> = { low: 10, medium: 20, high: 35, urgent: 50 };

export const taskXp = (t: Pick<Task, 'priority'>) => XP_BY_PRIORITY[t.priority] ?? 10;

/** 레벨 n → n+1 에 필요한 EXP: 100, 150, 200, … */
const needFor = (level: number) => 100 + (level - 1) * 50;

export interface PlayerStats {
  xp: number;
  level: number;
  /** 현재 레벨에서 모은 EXP / 다음 레벨까지 필요한 EXP */
  into: number;
  need: number;
  done: number;
}

export function playerStats(tasks: Task[]): PlayerStats {
  const doneTasks = tasks.filter((t) => t.status === 'done');
  const xp = doneTasks.reduce((s, t) => s + taskXp(t), 0);
  let level = 1;
  let rest = xp;
  while (rest >= needFor(level)) rest -= needFor(level++);
  return { xp, level, into: rest, need: needFor(level), done: doneTasks.length };
}

export const levelTitle = (level: number) => (level >= 20 ? '전설의 플래너' : level >= 10 ? '숙련 플래너' : level >= 5 ? '모험가 플래너' : '새싹 플래너');

/** 화면 아래 잠깐 뜨는 알림 (App 의 Toast 가 받는다) */
export const TOAST_EVENT = 'dotday:toast';
export function toast(text: string) {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: text }));
}

/** 투두 완료/되돌리기. 완료하면 얻은 EXP 를 알린다 */
export async function setTaskDone(repo: DomainRepository, t: Task, done: boolean) {
  await repo.updateTask(t.id, { status: done ? 'done' : 'todo' });
  if (done && t.status !== 'done') toast(`퀘스트 완료! +${taskXp(t)} EXP`);
}
