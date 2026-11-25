// Installs or removes the #796 boot setup (#996) under a filesystem root; the maintainer runs it once with sudo.
// Usage: sudo "$(command -v node)" load/harness-core/boot-796.ts install|uninstall
//        node load/harness-core/boot-796.ts check   (unprivileged; exit 0 when installed and current)
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  defaultTargetLink, grubTarget, hostFiles, hostService, irqbalanceLink, layoutProblems, multiUserTarget, sourceDir, stateFile, unitDir, wantsLink,
} from './boot-796-files.ts';

export type Run = (program: string, args: string[]) => void;
type Options = { source?: string; run?: Run; dryRun?: boolean };
// What install found before its first change, so uninstall can put it back.
type State = { version: 1; defaultTarget: string | null; irqbalanceMasked: boolean };
type Reload = { daemonReload: boolean; updateGrub: boolean };
// Present from before a reload until it succeeds, so a failed daemon-reload or update-grub reruns and `check` fails.
export const reloadPending = 'etc/fukulow-796/reload-pending.json';

const realRun: Run = (program, args) => { execFileSync(program, args, { stdio: 'inherit', timeout: 300_000 }); };
const noRun: Run = () => {};
type Found = { kind: 'none' | 'file' | 'dir' | 'link'; to: string | null };
function found(path: string): Found {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: 'link', to: readlinkSync(path) };
    return { kind: stat.isDirectory() ? 'dir' : 'file', to: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none', to: null };
    throw error;
  }
}
const sameFile = (path: string, content: Buffer, mode: number) =>
  found(path).kind === 'file' && (statSync(path).mode & 0o777) === mode && readFileSync(path).equals(content);

function readJson<T>(root: string, file: string, valid: (value: T) => boolean): T | null {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  let value: T;
  try { value = JSON.parse(readFileSync(path, 'utf8')) as T; } catch { throw new Error(`unreadable /${file}`); }
  if (!value || !valid(value)) throw new Error(`unreadable /${file}`);
  return value;
}
const readState = (root: string) => readJson<State>(root, stateFile, s => s.version === 1 &&
  (s.defaultTarget === null || typeof s.defaultTarget === 'string') && typeof s.irqbalanceMasked === 'boolean');
const readPending = (root: string) => readJson<Reload>(root, reloadPending, r =>
  typeof r.daemonReload === 'boolean' && typeof r.updateGrub === 'boolean');

function writeAtomic(path: string, content: Buffer | string, mode: number) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.fukulow-796.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function setLink(path: string, to: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.fukulow-796.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(to, temporary);
  renameSync(temporary, path);
}

// Refuses, before any change, a path whose kind install or uninstall would not replace safely.
function expectKinds(root: string, checks: [string, Found['kind'][], string][]) {
  for (const [path, kinds, why] of checks) {
    const kind = found(join(root, path)).kind;
    if (!kinds.includes(kind)) throw new Error(`/${path} is a ${kind === 'none' ? 'missing path' : kind}, ${why}; resolve it by hand first`);
  }
}

// Records the reloads the changes need (merged with any earlier failed one), runs them, then clears the record.
function reload(root: string, run: Run, changed: string[]) {
  const earlier = readPending(root);
  const needed: Reload = {
    daemonReload: Boolean(earlier?.daemonReload) || changed.some(path => path.startsWith(`/${unitDir}/`)),
    updateGrub: Boolean(earlier?.updateGrub) || changed.includes(`/${grubTarget}`),
  };
  if (!needed.daemonReload && !needed.updateGrub) return;
  writeAtomic(join(root, reloadPending), `${JSON.stringify(needed)}\n`, 0o644);
  if (needed.daemonReload) run('systemctl', ['daemon-reload']);
  if (needed.updateGrub) run('update-grub', []);
  unlinkSync(join(root, reloadPending));
}

// Returns the paths it changed (or would change, with dryRun). A second run returns none.
export function installBootSetup(root: string, { source = sourceDir, run = realRun, dryRun = false }: Options = {}) {
  const problems = layoutProblems(name => readFileSync(join(source, name), 'utf8'));
  if (problems.length) throw new Error(`boot-796 files disagree with the #796 layout: ${problems.join('; ')}`);
  if (!existsSync(join(root, multiUserTarget))) throw new Error(`${multiUserTarget} is missing`);
  const irqbalance = found(join(root, irqbalanceLink));
  if (irqbalance.kind !== 'none' && irqbalance.to !== '/dev/null') throw new Error(`/${irqbalanceLink} is not a mask; resolve it by hand first`);
  expectKinds(root, [
    ...hostFiles.map(file => [file.target, ['none', 'file'], 'not a regular file'] as [string, Found['kind'][], string]),
    [wantsLink, ['none', 'link'], 'not a symlink'],
    [defaultTargetLink, ['none', 'link'], 'not a symlink'],
  ]);
  const state = readState(root);
  const pending = readPending(root);
  const changed: string[] = [];
  const change = (target: string, apply: () => void) => { changed.push(`/${target}`); if (!dryRun) apply(); };
  if (!state) {
    const previous: State = { version: 1, defaultTarget: found(join(root, defaultTargetLink)).to, irqbalanceMasked: irqbalance.kind === 'link' };
    change(stateFile, () => writeAtomic(join(root, stateFile), `${JSON.stringify(previous, null, 2)}\n`, 0o644));
  }
  for (const file of hostFiles) {
    const content = readFileSync(join(source, file.source));
    const path = join(root, file.target);
    if (!sameFile(path, content, file.mode)) change(file.target, () => writeAtomic(path, content, file.mode));
  }
  const links: [string, string][] = [[wantsLink, `/${unitDir}/${hostService}`], [irqbalanceLink, '/dev/null'], [defaultTargetLink, multiUserTarget]];
  for (const [path, to] of links) {
    if (found(join(root, path)).to !== to) change(path, () => setLink(join(root, path), to));
  }
  if (dryRun) return pending ? [...changed, `/${reloadPending}`] : changed;
  reload(root, run, changed);
  return pending ? [...changed, `/${reloadPending}`] : changed;
}

// Removes every installed file and restores the default target and irqbalance mask install found. A second run returns none.
export function uninstallBootSetup(root: string, { run = realRun, dryRun = false }: Options = {}) {
  const state = readState(root);
  const installed = hostFiles.filter(file => found(join(root, file.target)).kind !== 'none').map(file => file.target);
  if (!state) {
    if (installed.length) throw new Error(`${stateFile} is missing, so the previous boot state is unknown`);
    return [];
  }
  expectKinds(root, [
    ...installed.map(target => [target, ['file'], 'not a regular file'] as [string, Found['kind'][], string]),
    [wantsLink, ['none', 'link'], 'not a symlink'],
    [defaultTargetLink, ['none', 'link'], 'not a symlink'],
  ]);
  const changed: string[] = [];
  const change = (target: string, apply: () => void) => { changed.push(`/${target}`); if (!dryRun) apply(); };
  for (const target of installed) change(target, () => unlinkSync(join(root, target)));
  if (found(join(root, wantsLink)).kind === 'link') change(wantsLink, () => unlinkSync(join(root, wantsLink)));
  if (!state.irqbalanceMasked && found(join(root, irqbalanceLink)).to === '/dev/null') {
    change(irqbalanceLink, () => unlinkSync(join(root, irqbalanceLink)));
  }
  const current = found(join(root, defaultTargetLink));
  if (state.defaultTarget === null && current.kind === 'link') change(defaultTargetLink, () => unlinkSync(join(root, defaultTargetLink)));
  if (state.defaultTarget !== null && current.to !== state.defaultTarget) {
    change(defaultTargetLink, () => setLink(join(root, defaultTargetLink), state.defaultTarget as string));
  }
  changed.push(`/${stateFile}`);
  if (dryRun) return changed;
  // Always reload while the state file exists, so an uninstall whose reload failed reruns it; the state goes last.
  reload(root, run, [`/${unitDir}/`, `/${grubTarget}`]);
  unlinkSync(join(root, stateFile));
  // Only directories install creates (drop-in, libexec, state), and only when empty.
  const owned = new Set([...hostFiles.map(file => dirname(file.target)), dirname(stateFile)]);
  for (const directory of [...owned].filter(d => d !== unitDir && d !== dirname(grubTarget))) {
    try { rmdirSync(join(root, directory)); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
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
  // A staging root never touches the live host's systemd or GRUB.
  const run = root === '/' ? realRun : noRun;
  const changed = command === 'uninstall' ? uninstallBootSetup(root, { run }) : installBootSetup(root, { run, dryRun: command === 'check' });
  console.log(JSON.stringify({ command, changed }, null, 2));
  if (command === 'check' && changed.length) process.exitCode = 1;
  else if (command !== 'check' && changed.length) console.error('reboot to apply: sudo systemctl reboot');
}
