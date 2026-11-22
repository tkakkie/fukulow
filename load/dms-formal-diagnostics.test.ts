import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { checked, execute, type Executor } from './dms-formal-exec.ts';
import { buildsBaseline, restoreVolumes, runWorkerStep } from './dms-formal-host.ts';
import { GiB } from './dms-formal-storage.ts';

function fixture(t:TestContext) {
  const directory=fs.mkdtempSync(tmpdir()+'/dm-restore-test-');
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const path=directory+'/worker.log';
  const write=(line:string)=>fs.appendFileSync(path,line,{mode:0o600});
  const secrets=[
    randomBytes(32).toString('hex'),
    'word '+randomBytes(6).toString('hex')+'/%',
    ['gh','p', '_',randomBytes(18).toString('hex')].join(''),
  ];
  const [password,token,key]=secrets;
  const sensitive=`postgres://operator:${encodeURIComponent(token!)}@db/test DATABASE_URL=${password} Authorization: Bearer ${key} ${token}`;
  const records=()=>{
    const text=fs.readFileSync(path,'utf8');
    for(const value of [...secrets,encodeURIComponent(token!),'postgres://','Authorization:']) {
      assert.ok(!text.includes(value),'diagnostics contain credential material');
    }
    return text.trim().split('\n').map(line=>JSON.parse(line));
  };
  return {directory,path,write,secrets,sensitive,records};
}

const config={target:'local',id:'dm-formal-test',postgres:'postgres:tag@sha256:test',mode:'formal'} as const;
const noDockerInfo=async()=>assert.fail('Local headroom must use the private root');
function fakeAvailable(t:TestContext,availableGiB:number) {
  const stat=fs.statfsSync(tmpdir());
  const mock=t.mock.method(fs,'statfsSync',()=>({...stat,bsize:4096,bavail:availableGiB*GiB/4096}));
  syncBuiltinESMExports();
  t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  return mock;
}

test('restore writes both filesystem samples before stopping the database',async t=>{
  const {directory,path,write,records,secrets}=fixture(t);
  fakeAvailable(t,120);
  const exec:Executor=async command=>{
    if(command.args[0]==='run'){
      assert.ok(command.captureStderr);
      return {code:0,stdout:secrets[0]!};
    }
    return {code:0,stdout:''};
  };
  await runWorkerStep('restore',4,async()=>{
    await restoreVolumes(config,4,{
      directory,write,exec,dockerInfo:noDockerInfo,
      stopDb:async()=>{
        assert.equal(records().length,1);
        return '';
      },
      probe:async (dockerArgs,signal)=>{
        assert.equal(signal.aborted,false);
        if(dockerArgs[0]==='volume')return secrets[0]!;
        assert.ok(dockerArgs.includes('postgres@sha256:test'));
        assert.ok(dockerArgs.includes('--pull=never'));
        assert.equal(dockerArgs.filter(arg=>arg.endsWith(',readonly,volume-nocopy')).length,2);
        assert.deepEqual(dockerArgs.slice(-5),['-f','-c','%a %S','/var/lib/postgresql','/snapshot']);
        return '250 4096\n1000 4096\n';
      },
    });
  },write);
  assert.deepEqual(records(),[{event:'restore-space',step:'restore',attempt:4,hostFreeBytes:120*GiB,dataFreeBytes:1024000,snapshotFreeBytes:4096000}]);
  assert.equal(fs.statSync(path).mode&0o777,0o600);
});

test('restore records the existing headroom failure and skips the copy',async t=>{
  const {directory,write,records,sensitive}=fixture(t);
  fakeAvailable(t,99);
  await assert.rejects(runWorkerStep('restore',2,async()=>{
    await restoreVolumes(config,2,{
      directory,write,dockerInfo:noDockerInfo,stopDb:async()=>'',
      exec:async()=>assert.fail('The headroom check must prevent the copy'),
      probe:async()=>{throw new Error(sensitive);},
    });
  },write),/Storage headroom insufficient/);
  const [space,failure]=records();
  assert.equal(space.hostFreeBytes,99*GiB);
  assert.equal(space.dataFreeBytes,null);
  assert.equal(space.snapshotFreeBytes,null);
  assert.deepEqual(failure,{
    event:'worker-failure',step:'restore',attempt:2,workerExitCode:1,exitCode:null,errorClass:'HeadroomError',
    message:'Storage headroom insufficient',requiredBytes:100*GiB,observedBytes:99*GiB,
  });
});

test('copy exit 1 remains visible even if copy cleanup fails',async t=>{
  const {directory,write,records,sensitive}=fixture(t),commands:string[]=[];
  fakeAvailable(t,120);
  const cleanupFailure=new TypeError(sensitive);
  await assert.rejects(runWorkerStep('restore',3,async()=>{
    await restoreVolumes(config,3,{
      directory,write,dockerInfo:noDockerInfo,stopDb:async()=>'',
      probe:async()=>{throw new Error(sensitive);},
      exec:async command=>{
        commands.push(command.args[0]!);
        if(command.args[0]==='run')return {code:1,stdout:sensitive,stderr:`cp: ${sensitive}: Permission denied`};
        throw cleanupFailure;
      },
    });
  },write),error=>error===cleanupFailure);
  assert.deepEqual(commands,['run','ps']);
  const [space,copy,failure]=records();
  assert.equal(space.dataFreeBytes,null);
  assert.deepEqual(copy,{
    event:'restore-copy-failure',step:'restore',attempt:3,exitCode:1,errorClass:'CommandFailure',message:'Permission denied',
  });
  assert.equal(failure.errorClass,'TypeError');
});

test('worker failures suppress arbitrary messages and preserve the original exception when logging fails',async t=>{
  const {write,records,sensitive,secrets}=fixture(t);
  const exception=new SyntaxError(sensitive);
  await assert.rejects(runWorkerStep('seed',0,async()=>{throw exception;},write),error=>error===exception);
  const namedException=new Error(sensitive);
  namedException.name=secrets[0]!;
  await assert.rejects(runWorkerStep(secrets[0],0,async()=>{throw namedException;},write));
  await assert.rejects(runWorkerStep('seed',0,async()=>{throw exception;},()=>{throw new Error(sensitive);}),error=>error===exception);
  const [known,unknown]=records();
  assert.equal(known.step,'seed');
  assert.equal(known.errorClass,'SyntaxError');
  assert.equal(unknown.step,'unknown');
  assert.equal(unknown.message,'Unexpected worker failure [detail redacted]');
});

test('failed diagnostics do not block a successful restore or alter the remote headroom check',async t=>{
  const {directory,sensitive}=fixture(t),commands:string[]=[];
  const stat=fakeAvailable(t,120);
  await restoreVolumes({...config,target:'ssh'},1,{
    directory,
    stopDb:async()=>{commands.push('stop-db');return '';},
    dockerInfo:async()=>JSON.stringify({DockerRootDir:'/docker-data'}),
    probe:async()=>{throw new Error(sensitive);},
    write:()=>{throw new Error(sensitive);},
    exec:async command=>{commands.push(command.args[0]!);return {code:0,stdout:''};},
  });
  assert.deepEqual(stat.mock.calls.map(call=>call.arguments),[[directory],['/docker-data']]);
  assert.deepEqual(commands,['stop-db','run','ps']);
});

test('restore command stderr is captured without writing its contents to the worker log',async t=>{
  const {write,records,sensitive}=fixture(t);
  await assert.rejects(runWorkerStep('restore',1,async()=>{
    await checked(execute,{
      program:process.execPath,
      args:['-e',"process.stdin.pipe(process.stderr); process.exitCode=1"],
      input:`cp: ${sensitive}: No space left on device`,timeout:5000,captureStderr:true,
    });
  },write),/failed \(exit 1\)/);
  assert.equal(records()[0].message,'No space left on device');
  assert.equal(records()[0].exitCode,1);
});

test('only formal pool-overhead runs build the baseline image; the seed diagnostic skips it', () => {
  assert.equal(buildsBaseline({ overhead: true }), true);
  assert.equal(buildsBaseline({ overhead: true, pilot: true }), false);
  assert.equal(buildsBaseline({ overhead: true, seedDiagnostic: true }), false);
  assert.equal(buildsBaseline({ overhead: false }), false);
});
