// Check only Git-tracked files. Never reads the user's untracked data directory.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = /(^|\/)(data|node_modules|dist|evidence|test-results|playwright-report|\.agent|\.codex|work)(\/|$)|\.(db|sqlite|sqlite3|pid|log|pem|key)(-|$)|(^|\/)\.env($|\.)/i;
const privateText = /\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|origin\.cursor\.com|\/opt\/cursor\/agent-store|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{32,})/;
const findings = [];
for (const path of files) {
  if (forbidden.test(path)) findings.push(`${path}: runtime/private file`);
  if (lstatSync(path).isSymbolicLink()) { findings.push(`${path}: symlink`); continue; }
  if (!/\.(png|jpg|jpeg|gif|ico|woff2?)$/i.test(path) && privateText.test(readFileSync(path, 'utf8'))) findings.push(`${path}: private path or secret pattern`);
}
if (findings.length) { console.error(findings.join('\n')); process.exit(1); }
console.log(`Public-tree guard: ${files.length} tracked files checked; no forbidden files or private patterns.`);
