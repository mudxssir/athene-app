// ============================================================
// lib/qstash/__tests__/system-crons.test.ts
//
// Unit tests for registerSystemCrons() (audit plan item 5C.3).
//
// Coverage:
//   - Skips registration when NEXT_PUBLIC_APP_URL is not set
//   - Creates all schedules when none are pre-registered (first deploy)
//   - Skips schedules whose destination URL is already registered (idempotency)
//   - Creates only missing schedules when some are already registered
//   - Aborts all creation and logs when schedules.list() fails
//   - Logs per-schedule error but continues remaining schedules on create failure
//   - Passes correct cron expression to each create call
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// vi.mock factories run before const declarations (hoisted).
// Use vi.hoisted() to make the controllable stubs available inside factories.
const { schedulesList, schedulesCreate, loggerMock } = vi.hoisted(() => ({
  schedulesList: vi.fn(),
  schedulesCreate: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({ logger: loggerMock }));

vi.mock('@/lib/qstash/client', () => ({
  qstash: {
    schedules: {
      list: schedulesList,
      create: schedulesCreate,
    },
  },
}));

import { registerSystemCrons, SYSTEM_CRON_DEFS } from '@/lib/qstash/system-crons';

const APP_URL = 'https://app.example.com';

function fakeSchedule(destination: string) {
  return {
    scheduleId: `sched-${Math.random().toString(36).slice(2)}`,
    destination,
    cron: '* * * * *',
    createdAt: Date.now(),
    method: 'POST',
    retries: 3,
    isPaused: false,
  };
}

describe('registerSystemCrons', () => {
  const originalUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalUrl;
  });

  it('no-ops and logs a warning when NEXT_PUBLIC_APP_URL is not set', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await registerSystemCrons();
    expect(schedulesList).not.toHaveBeenCalled();
    expect(schedulesCreate).not.toHaveBeenCalled();
    expect((loggerMock.warn as Mock)).toHaveBeenCalledWith(
      {},
      expect.stringContaining('NEXT_PUBLIC_APP_URL not set'),
    );
  });

  it('creates all system crons when none are currently registered', async () => {
    schedulesList.mockResolvedValue([]);
    schedulesCreate.mockResolvedValue({ scheduleId: 'new-id' });

    await registerSystemCrons();

    expect(schedulesCreate).toHaveBeenCalledTimes(SYSTEM_CRON_DEFS.length);
    for (const def of SYSTEM_CRON_DEFS) {
      expect(schedulesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ destination: `${APP_URL}${def.path}` }),
      );
    }
  });

  it('skips all schedules when every destination is already registered (true idempotency)', async () => {
    const existing = SYSTEM_CRON_DEFS.map((def) =>
      fakeSchedule(`${APP_URL}${def.path}`),
    );
    schedulesList.mockResolvedValue(existing);

    await registerSystemCrons();

    expect(schedulesCreate).not.toHaveBeenCalled();
    // Confirms "Already registered" was logged for at least one schedule
    expect((loggerMock.info as Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.any(String) }),
      expect.stringContaining('Already registered'),
    );
  });

  it('creates only the schedules whose destination is not yet registered', async () => {
    const firstDef = SYSTEM_CRON_DEFS[0];
    const rest = SYSTEM_CRON_DEFS.slice(1);

    schedulesList.mockResolvedValue([fakeSchedule(`${APP_URL}${firstDef.path}`)]);
    schedulesCreate.mockResolvedValue({ scheduleId: 'partial-id' });

    await registerSystemCrons();

    expect(schedulesCreate).toHaveBeenCalledTimes(rest.length);
    for (const def of rest) {
      expect(schedulesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ destination: `${APP_URL}${def.path}` }),
      );
    }
    expect(schedulesCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ destination: `${APP_URL}${firstDef.path}` }),
    );
  });

  it('aborts all schedule creation and logs an error when schedules.list() throws', async () => {
    schedulesList.mockRejectedValue(new Error('QStash API unreachable'));

    await registerSystemCrons();

    expect(schedulesCreate).not.toHaveBeenCalled();
    expect((loggerMock.error as Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'QStash API unreachable' }),
      expect.stringContaining('Failed to list existing schedules'),
    );
  });

  it('continues with remaining schedules when one create call fails', async () => {
    schedulesList.mockResolvedValue([]);
    schedulesCreate
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue({ scheduleId: 'ok-id' });

    await registerSystemCrons();

    // All definitions were attempted despite the first failure
    expect(schedulesCreate).toHaveBeenCalledTimes(SYSTEM_CRON_DEFS.length);
    expect((loggerMock.error as Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'network error' }),
      expect.stringContaining('Registration failed'),
    );
    // At least one success log for the schedules that did create
    expect((loggerMock.info as Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'ok-id' }),
      expect.stringContaining('Registered'),
    );
  });

  it('passes the correct cron expression to each create call', async () => {
    schedulesList.mockResolvedValue([]);
    schedulesCreate.mockResolvedValue({ scheduleId: 'id' });

    await registerSystemCrons();

    for (const def of SYSTEM_CRON_DEFS) {
      expect(schedulesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ cron: def.cron }),
      );
    }
  });

  it('calls schedules.list() exactly once per invocation', async () => {
    schedulesList.mockResolvedValue([]);
    schedulesCreate.mockResolvedValue({ scheduleId: 'id' });

    await registerSystemCrons();

    expect(schedulesList).toHaveBeenCalledTimes(1);
  });
});
