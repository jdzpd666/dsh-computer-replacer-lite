// Copy the hand-authored client bundle into dist/client.js.
// The bundle is written directly in the DSH client ModuleLoader format
// (window.__ModuleLoader__.load({id, factory})); react is resolved by the
// shell at runtime, so no bundler or npm dependency is required.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'src', 'client', 'client.js');
const target = join(root, 'dist', 'client.js');
copyFileSync(source, target);
const bytes = statSync(target).size;
if (bytes < 1000) throw new Error('client bundle suspiciously small: ' + bytes + ' bytes');
console.log('CLIENT_BUNDLE ' + target + ' bytes=' + bytes);
