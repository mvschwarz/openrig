import { writeWindowsNodeFixture } from './windows-node-fixture.mjs';

// The POSIX tests retain their shell fixture; Windows needs an executable that
// cmd.exe can find while the real gate is exercising its ordinary npm legs.
export function writeNativeGateNpm(directory) {
  if (process.platform !== 'win32') return;
  writeWindowsNodeFixture(directory, 'npm', `
import fs from 'node:fs';
fs.writeFileSync(process.env.OPENRIG_TEST_MARKER, '');
if (process.env.OPENRIG_TEST_RELEASE) {
  const poll=setInterval(() => { if(fs.existsSync(process.env.OPENRIG_TEST_RELEASE)){clearInterval(poll);process.exit(0);} },20);
} else setTimeout(() => process.exit(0),1000);
`);
}
