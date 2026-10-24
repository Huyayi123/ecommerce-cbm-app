export const ALIBABA_PROGRESS_INTERVAL_MS = 15000;

const runKey = (userId: string) => `alibaba-sync-run:${userId}`;
export function savedAlibabaRun(userId: string): string | null {
  try {
    const value=sessionStorage.getItem(runKey(userId));
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
  } catch { return null; }
}
export function saveAlibabaRun(userId: string, runId: string | null) {
  try { if(runId)sessionStorage.setItem(runKey(userId),runId);else sessionStorage.removeItem(runKey(userId)); } catch { /* Polling still works without browser storage. */ }
}

export function createAlibabaProgressTracker() {
  let previousFinished = 0;
  let completed = false;
  return (state: { state: string; total: number; success: number; failed: number; skipped: number }) => {
    const values = [state.total, state.success, state.failed, state.skipped];
    if (values.some(value => !Number.isSafeInteger(value) || value < 0) || !['running','complete'].includes(state.state)) {
      throw new Error('物流进度格式异常，请稍后重新查看。');
    }
    const finished = state.success + state.failed + state.skipped;
    if (finished > state.total || finished < previousFinished) throw new Error('物流进度不一致，请稍后重新查看。');
    const complete = state.state === 'complete';
    const reload = finished > previousFinished || (complete && !completed);
    previousFinished = finished;
    completed = complete;
    return { finished, complete, reload };
  };
}
