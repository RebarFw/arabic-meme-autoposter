import { AppError, errorCode, log, type Env } from './types';

type TaskPath = '/admin/cloudflare/usage' | '/admin/tasks/cleanup-reservations' | '/admin/tasks/poll' | '/admin/tasks/maintenance' | '/admin/tasks/job' | '/admin/tasks/enqueue';
export async function cloudTask(env: Env, path: TaskPath, body?: Record<string, unknown>) {
  if (!env.ADMIN_TOKEN || !env.PUBLIC_BASE_URL) throw new AppError('scheduled_tasks_not_configured');
  const base = new URL(env.PUBLIC_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new AppError('invalid_scheduled_origin');
  const response = await fetch(new URL(path, base), {
    method: path === '/admin/cloudflare/usage' ? 'GET' : 'POST',
    redirect: 'manual', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`scheduled_task_http_${response.status}`); }
  return await response.json() as { allowed?: boolean; code?: string; jobIds?: string[]; jobId?: string; nextStage?: boolean };
}

// Public HTTP invocations have separate Free-plan CPU budgets. Moving all
// processing into waitUntil would still leave it in one invocation.
export async function runScheduledTasks(env: Env): Promise<void> {
  const task = (path: TaskPath, body?: Record<string, unknown>) => cloudTask(env, path, body);
  // Refresh expensive account analytics in its own invocation before any
  // ingest/publishing task. Each task also enforces the existing quota guard.
  const capacity = await task('/admin/cloudflare/usage');
  if (capacity.allowed !== true) {
    if (capacity.code?.startsWith('cloudflare_r2_')) await task('/admin/tasks/cleanup-reservations');
    log('cloudflare_quota_paused', { code: capacity.code ?? 'cloudflare_usage_unavailable' });
    return;
  }
  try { await task('/admin/tasks/poll'); }
  catch (error) { log('scheduled_poll_failed', { code: errorCode(error) }); }
  const maintenance = await task('/admin/tasks/maintenance');
  for (const jobId of (maintenance.jobIds ?? []).slice(0, 3)) {
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw new AppError('invalid_scheduled_job');
    try {
      // Download, publish, and reconciliation each get a separate CPU budget.
      for (let stage = 0; stage < 3; stage++) {
        if (!(await task('/admin/tasks/job', { jobId })).nextStage) break;
      }
    } catch (error) { log('scheduled_job_failed', { job: jobId, code: errorCode(error) }); }
  }
}
