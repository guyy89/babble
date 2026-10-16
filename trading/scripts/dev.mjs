// Runs the server and web dev processes together on any OS
// (`a & b` in an npm script only works in POSIX shells, not on Windows).
import { spawn } from 'node:child_process';

const children = ['server', 'web'].map((ws) =>
  spawn(`npm run dev -w ${ws}`, { stdio: 'inherit', shell: true }),
);

let exiting = false;
const stopAll = (code) => {
  if (exiting) return;
  exiting = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
};

for (const c of children) c.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
