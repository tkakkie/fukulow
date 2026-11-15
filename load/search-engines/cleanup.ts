// Explicit operator cleanup only; runners never sweep another invocation's resources.
import { ownedResources } from './runtime.ts';
import { docker } from './bench.ts';

if (process.argv.slice(2).some(arg=>arg!=='--remove')) throw new Error('Usage: node load/search-engines/cleanup.ts [--remove]');
const resources = ownedResources(docker);
for (const {kind,name} of resources) console.log(`${kind} ${name}`);
if (process.argv.includes('--remove')) {
  for (const {kind,name} of resources) {
    if (kind==='container') docker('rm','-fv',name);
    else docker('volume','rm',name);
  }
  if (ownedResources(docker).length) throw new Error('Harness cleanup verification failed');
  console.log('Harness cleanup verified');
} else console.log('Inspection only. To remove these resources explicitly, rerun with --remove.');
