import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const checkout=resolve(import.meta.dirname,'..');
export function temporary(t: {after:(fn:()=>void)=>void}) { const path=mkdtempSync(`${tmpdir()}/dm-formal-test-`);t.after(()=>rmSync(path,{recursive:true,force:true}));return path; }
