import { ownedResources } from '../runtime.ts';

type Resource = ReturnType<typeof ownedResources>[number];

export function cleanupResources(docker: (...args: string[]) => string, expected: Resource[]) {
  let found: Resource[];
  const failures: string[] = [];
  try { found = ownedResources(docker); }
  catch (error) {
    failures.push(`listing failed: ${String(error)}`);
    found = expected;
  }
  for (const r of found) {
    try {
      docker(...(r.kind === 'container' ? ['rm', '-fv', r.name] : ['volume', 'rm', '-f', r.name]));
    } catch (error) { failures.push(`${r.kind} ${r.name}: ${String(error)}`); }
  }
  try {
    const remain = ownedResources(docker);
    if (remain.length) failures.push(`still present: ${remain.map(r => `${r.kind} ${r.name}`).join(', ')}`);
  } catch (error) { failures.push(`verification failed: ${String(error)}`); }
  return {verified: failures.length === 0, found, failures};
}
