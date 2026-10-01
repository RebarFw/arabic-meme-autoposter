import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

try {
  const staged = process.argv.includes('--staged');
  const paths = execFileSync('git', staged ? ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'] : ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const values = existsSync('.secrets') ? readdirSync('.secrets').map(name => readFileSync('.secrets/' + name, 'utf8').trim()).filter(value => value.length >= 20) : [];
  for (const path of paths) {
    if (/^(?:\.secrets\/|\.reference\/|\.local\/|\.env|\.dev\.vars$)/.test(path)) throw new Error('private_file_tracked');
    const body = staged ? execFileSync('git', ['show', ':' + path], { encoding: 'utf8', maxBuffer: 10000000 }) : readFileSync(path, 'utf8');
    if (values.some(value => body.includes(value))) throw new Error('credential_detected');
  }
  console.log(`Secret exclusion scan passed for ${paths.length} ${staged ? 'staged' : 'tracked'} files; no credential values displayed.`);
} catch { console.error('Secret scan failed; content and credential-bearing filenames were suppressed.'); process.exitCode = 1; }
