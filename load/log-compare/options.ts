import { resolve } from 'node:path';
export function parseOptions(args:string[]) {
  const smoke=args.includes('--smoke'),full=args.includes('--full'),diagnose=args.includes('--diagnose');
  if(Number(smoke)+Number(full)+Number(diagnose)!==1) throw new Error('choose exactly --smoke, --full or --diagnose (see --help)');
  const flags=['--smoke','--full','--diagnose','--settle-fixture'];
  const parameters=['--out','--rates','--seconds','--max-seconds','--clients','--rounds'];
  const option=(name:string,fallback:string)=>{const i=args.indexOf(name);if(i<0)return fallback;if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`missing ${name}`);return args[i+1];};
  const integer=(name:string,fallback:number,min=1)=>{const n=Number(option(name,String(fallback)));if(!Number.isSafeInteger(n)||n<min)throw new Error(`invalid ${name}`);return n;};
  for(let i=0;i<args.length;i++) {
    if(flags.includes(args[i]))continue;
    if(!parameters.includes(args[i]))throw new Error(`unknown option ${args[i]}`);
    option(args[i],'');i++;
  }
  if((smoke||diagnose) && args.some(a=>parameters.slice(1).includes(a)))throw new Error('smoke/diagnose parameters are bounded; use --full for overrides');
  const rounds=integer('--rounds',3,3),seconds=integer('--seconds',smoke?1:30),maxSeconds=integer('--max-seconds',smoke?1:15),clients=integer('--clients',smoke?2:16);
  if(clients>32)throw new Error('clients must be <=32');
  const rates=option('--rates',smoke?'20':diagnose?'50,250':'50,250,1000').split(',').map(Number);
  if(rates.some(n=>!Number.isSafeInteger(n)||n<=0)||new Set(rates).size!==rates.length)throw new Error('invalid rates');
  rates.sort((a,b)=>a-b);
  const out=resolve(option('--out',`/private/tmp/fukulow-i160-${Date.now()}`));
  if(out===process.cwd() || out.startsWith(process.cwd()+'/'))throw new Error('artifacts must be outside checkout');
  return {smoke,full,diagnose,settleFixture:args.includes('--settle-fixture'),rounds,seconds,maxSeconds,clients,rates,out};
}
export const fixtureCondition=(settleFixture:boolean)=>settleFixture ? {settleFixture:true as const} : {};
