import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { Env } from '../src/types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env extends ImportedEnv { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1]; }
  }
}
type ImportedEnv = Env;
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
