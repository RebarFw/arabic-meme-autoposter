import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('./migrations');
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { compatibilityFlags: ['nodejs_compat'], bindings: { TEST_MIGRATIONS: migrations, CLOUDFLARE_USAGE_GUARD: 'false', ADMIN_TOKEN: 'test-admin', META_APP_SECRET: 'test-app-secret', META_VERIFY_TOKEN: 'test-verify', OWNER_IG_SENDER_ID: '111', FRIEND_IG_SENDER_ID: '777', EXPECTED_INSTAGRAM_CHANNEL_ID: '', EXPECTED_TIKTOK_CHANNEL_ID: '', EXPECTED_INSTAGRAM_USERNAME: '', EXPECTED_TIKTOK_USERNAME: '', CLOUDFLARE_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', CLOUDFLARE_DATABASE_ID: 'test-database', INGEST_MODE: 'webhook', PUBLIC_BASE_URL: 'https://worker.example' } },
  })],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
});
