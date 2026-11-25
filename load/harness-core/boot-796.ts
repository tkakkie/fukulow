// Installs or removes the #796 boot setup (#996) under a filesystem root; the maintainer runs it once with sudo.
// Usage: sudo "$(command -v node)" load/harness-core/boot-796.ts install|uninstall
//        node load/harness-core/boot-796.ts check   (unprivileged; exit 0 when installed and current)
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  defaultTargetLink, grubTarget, hostFiles, hostService, irqbalanceLink, layoutProblems, multiUserTarget, sourceDir, stateFile, unitDir, wantsLink,
} from './boot-796-files.ts';

type Run = (program: string, args: string[]) => void;
type Options = { source?: string; run?: Run; dryRun?: boolean };
// What install found before its first change, so uninstall can put it back.
type State = { version: 1; defaultTarget: string | null; irqbalanceMasked: boolean };

const realRun: Run = (program, args) => { execFileSync(program, args, { stdio: 'inherit', timeout: 300_000 }); };
const link = (path: string) => {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? { kind: 'link' as const, to: readlinkSync(path) } : { kind: 'file' as const, to: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' as const, to: null };
    throw error;
  }
};
const sameFile = (path: string, content: Buffer, mode: number) =>
  link(path).kind === 'file' && (statSync(path).mode & 0o777) === mode && readFileSync(path).equals(content);

function readState(root: string): State | null {
  const path = join(root, stateFile);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, 'utf8')) as State;
  if (state?.version !== 1 || (state.defaultTarget !== null && typeof state.defaultTarget !== 'string') || typeof state.irqbalanceMasked !== 'boolean') {
    throw new Error(`unreadable ${stateFile}`);
  }
  return state;
}

function writeAtomic(path: string, content: Buffer | string, mode: number) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.fukulow-796.tmp`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function setLink(path: string, to: string) {
  if (link(path).kind === 'link') unlinkSync(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  symlinkSync(to, path);
}

function reload(run: Run, changed: string[]) {
  if (changed.some(path => path.startsWith(`/${unitDir}/`))) run('systemctl', ['daemon-reload']);
  if (changed.includes(`/${grubTarget}`)) run('update-grub', []);
}

// Returns the paths it changed (or would change, with dryRun). A second run returns none.
export function installBootSetup(root: string, { source = sourceDir, run = realRun, dryRun = false }: Options = {}) {
  const problems = layoutProblems(name => readFileSync(join(source, name), 'utf8'));
  if (problems.length) throw new Error(`boot-796 files disagree with the #796 layout: ${problems.join('; ')}`);
  if (!existsSync(join(root, multiUserTarget))) throw new Error(`${multiUserTarget} is missing`);
  const irqbalance = link(join(root, irqbalanceLink));
  if (irqbalance.kind === 'file' || (irqbalance.kind === 'link' && irqbalance.to !== '/dev/null')) {
    throw new Error(`/${irqbalanceLink} is not a mask; resolve it by hand first`);
  }
  const defaultTarget = link(join(root, defaultTargetLink));
  if (defaultTarget.kind === 'file') throw new Error(`/${defaultTargetLink} is not a symlink; resolve it by hand first`);
  const changed: string[] = [];
  const change = (target: string, apply: () => void) => { changed.push(`/${target}`); if (!dryRun) apply(); };
  if (!readState(root)) {
    const state: State = { version: 1, defaultTarget: defaultTarget.to, irqbalanceMasked: irqbalance.kind === 'link' };
    change(stateFile, () => writeAtomic(join(root, stateFile), `${JSON.stringify(state, null, 2)}\n`, 0o644));
  }
  for (const file of hostFiles) {
    const content = readFileSync(join(source, file.source));
    const path = join(root, file.target);
    if (link(path).kind === 'link') throw new Error(`/${file.target} is a symlink; resolve it by hand first`);
    if (!sameFile(path, content, file.mode)) change(file.target, () => writeAtomic(path, content, file.mode));
  }
  const links: [string, string][] = [[wantsLink, `/${unitDir}/${hostService}`], [irqbalanceLink, '/dev/null'], [defaultTargetLink, multiUserTarget]];
  for (const [path, to] of links) {
    if (link(join(root, path)).to !== to) change(path, () => setLink(join(root, path), to));
  }
  if (!dryRun) reload(run, changed);
  return changed;
}

// Removes every installed file and restores the default target and irqbalance mask install found. A second run returns none.
export function uninstallBootSetup(root: string, { run = realRun, dryRun = false }: Options = {}) {
  const state = readState(root);
  const installed = hostFiles.filter(file => link(join(root, file.target)).kind !== 'none').map(file => file.target);
  if (!state) {
    if (installed.length) throw new Error(`${stateFile} is missing, so the previous boot state is unknown`);
    return [];
  }
  const changed: string[] = [];
  const change = (target: string, apply: () => void) => { changed.push(`/${target}`); if (!dryRun) apply(); };
  for (const target of installed) change(target, () => unlinkSync(join(root, target)));
  if (link(join(root, wantsLink)).kind === 'link') change(wantsLink, () => unlinkSync(join(root, wantsLink)));
  if (!state.irqbalanceMasked && link(join(root, irqbalanceLink)).to === '/dev/null') {
    change(irqbalanceLink, () => unlinkSync(join(root, irqbalanceLink)));
  }
  const current = link(join(root, defaultTargetLink));
  if (state.defaultTarget === null && current.kind === 'link') change(defaultTargetLink, () => unlinkSync(join(root, defaultTargetLink)));
  if (state.defaultTarget !== null && current.to !== state.defaultTarget) {
    change(defaultTargetLink, () => setLink(join(root, defaultTargetLink), state.defaultTarget as string));
  }
  change(stateFile, () => unlinkSync(join(root, stateFile)));
  if (dryRun) return changed;
  // Only directories install creates (drop-in, libexec, state), and only when empty.
  const owned = new Set([...hostFiles.map(file => dirname(file.target)), dirname(stateFile)]);
  for (const directory of [...owned].filter(d => d !== unitDir && d !== dirname(grubTarget))) {
    try { rmdirSync(join(root, directory)); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  reload(run, changed);
  return changed;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const rootAt = rest.indexOf('--root');
  const root = rootAt >= 0 ? rest[rootAt + 1] : '/';
  if (!['install', 'uninstall', 'check'].includes(command) || (rootAt >= 0 && !root) || rest.length !== (rootAt >= 0 ? 2 : 0)) {
    console.error('usage: boot-796.ts install|uninstall|check [--root DIR]');
    process.exit(2);
  }
  if (command !== 'check' && root === '/' && process.getuid?.() !== 0) {
    console.error(`${command} changes the host: run it with sudo`);
    process.exit(2);
  }
  const changed = command === 'uninstall' ? uninstallBootSetup(root) : installBootSetup(root, { dryRun: command === 'check' });
  console.log(JSON.stringify({ command, changed }, null, 2));
  if (command === 'check' && changed.length) process.exitCode = 1;
  else if (command !== 'check' && changed.length) console.error('reboot to apply: sudo systemctl reboot');
}
