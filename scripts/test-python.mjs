import {spawnSync} from 'node:child_process';
const result=spawnSync(process.env.LONG_MEMORY_PYTHON||'python',['-m','unittest','discover','-s','tests','-p','test_*.py','-v'],{stdio:'inherit',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'}});
if(result.error)throw result.error;process.exitCode=result.status??1;
