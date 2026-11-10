import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskState } from './TaskStatusDetail';
import type { ProcessingJob } from './ProcessingHistory';
const job: ProcessingJob = {id:'test',name:'test.m4a',status:'waiting',stage:'saving',seconds:6,error:null};
const render = (status:string,busy=false) => renderToStaticMarkup(<TaskState job={{...job,status}} busy={busy} onRetry={()=>{}}/>);
it('等待与运行不重复入队，运行显示真实阶段且无百分比',()=>{
 expect(render('waiting')).not.toContain('<button');
 expect(render('running')).toContain('正在保存');
 expect(render('running')).not.toContain('<button');
 expect(render('running')).not.toContain('%');
});
it('失败与中断提供相应操作并在请求中锁定',()=>{
 expect(render('failed')).toContain('重试</button>');
 expect(render('failed')).toContain('片段记录未保存成功');
 expect(render('interrupted')).toContain('继续</button>');
 expect(render('interrupted',true)).toContain('disabled');
});
