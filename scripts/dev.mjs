// Minimal restart-on-change runner for the API (node --watch is unreliable on some Windows setups).
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';

let child;
let timer;
const start = () => {
  child = spawn(process.execPath, ['--env-file-if-exists=.env', '--env-file-if-exists=.env.local', 'src/server/index.ts'], { stdio: 'inherit' });
};
const restart = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log('[dev] change detected, restarting API…');
    if (child && child.exitCode === null) {
      child.once('exit', start);
      child.kill();
    } else start();
  }, 300);
};
watch('src/server', { recursive: true }, (_e, file) => file && file.endsWith('.ts') && restart());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child?.kill(); process.exit(0); });
start();
