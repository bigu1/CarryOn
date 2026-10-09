// Fail closed. Do not print process arguments or its environment (may contain secrets).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const [pid, root, pidFile] = process.argv.slice(2);
if (!/^\d+$/.test(pid ?? '') || !root || !pidFile) process.exit(1);
try {
  const entry = join(root, 'src/server/index.ts');
  let ownsEntry = false;
  let ownsFile = false;
  if (existsSync(`/proc/${pid}/cmdline`)) {
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    ownsEntry = args.some((a) => a === entry || (a === 'src/server/index.ts' && realpathSync(cwd) === realpathSync(root)));
    ownsFile = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`XUSHANG_PID_FILE=${pidFile}`);
  } else {
    const args = execFileSync('ps', ['-p', pid, '-o', 'args='], { encoding: 'utf8' }).trim();
    const cwdLines = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n');
    const cwdMatches = cwdLines.includes(`n${realpathSync(root)}`) || cwdLines.includes(`n${root}`);
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ownsEntry = new RegExp(`(?:^|\\s)${escape(entry)}(?:\\s|$)`).test(args) ||
      (cwdMatches && /(?:^|\s)src\/server\/index\.ts(?:\s|$)/.test(args));
    const env = execFileSync('ps', ['-p', pid, '-E', '-o', 'command='], { encoding: 'utf8' });
    // A PID-file value containing spaces ends only at the next environment assignment.
    ownsFile = new RegExp(`(?:^|\\s)XUSHANG_PID_FILE=${escape(pidFile)}(?=\\s+[A-Za-z_][A-Za-z0-9_]*=|\\s*$)`).test(env);
  }
  process.exit(ownsEntry && ownsFile ? 0 : 1);
} catch { process.exit(1); }
