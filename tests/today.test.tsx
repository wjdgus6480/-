import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { createServices } from '../src/app/services';
import type { Task } from '../src/domain/types';
import { todayStr } from '../src/ui/calendarGrid';
import { playerStats, taskXp } from '../src/ui/xp';

afterEach(cleanup);

const t = (priority: Task['priority'], status: Task['status'] = 'done') => ({ priority, status }) as Task;

describe('EXP·레벨 계산', () => {
  it('완료한 투두의 우선순위별 EXP 를 더하고, 레벨마다 필요한 EXP 가 50씩 늘어난다', () => {
    expect(taskXp(t('urgent'))).toBe(50);
    expect(playerStats([])).toMatchObject({ xp: 0, level: 1, into: 0, need: 100 });
    // 50+50+35 = 135 → 레벨1(100) 통과, 35/150
    expect(playerStats([t('urgent'), t('urgent'), t('high'), t('low', 'todo')])).toMatchObject({ xp: 135, level: 2, into: 35, need: 150, done: 3 });
  });
});

describe('오늘 대시보드', () => {
  it('빠른 추가는 오늘 마감 투두를 만들고, 완료하면 EXP 알림이 뜬다', async () => {
    const s = await createServices(`today-${Math.random()}`);
    location.hash = '#today';
    render(<App services={s} />);
    const input = await screen.findByLabelText('오늘 할 일 빠르게 추가');
    fireEvent.change(input, { target: { value: '물 2리터 마시기' } });
    fireEvent.submit(input.closest('form')!);
    const quests = await screen.findByText('오늘의 퀘스트');
    const box = await within(quests.parentElement!).findByLabelText('물 2리터 마시기 완료');
    expect((await s.domain.snapshot()).tasks[0]).toMatchObject({ title: '물 2리터 마시기', due_date: todayStr() });

    fireEvent.click(box);
    expect(await screen.findByText('퀘스트 완료! +20 EXP')).toBeTruthy();
    await waitFor(async () => expect((await s.domain.snapshot()).tasks[0].status).toBe('done'));
    await act(async () => {
      s.sync.stop();
      s.domainSync.stop();
    });
  });
});
