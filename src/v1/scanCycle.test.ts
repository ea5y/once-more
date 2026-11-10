import { describe, it, expect } from 'vitest';
import { cycleView } from './scanCycle';
import type { ProcessingSnapshot } from './ProcessingHistory';
const job = (id: string, status: string) => ({ id, name: id, status, stage: 'transcribing', seconds: 6, error: null });
describe('sidebar cycle', () => {
  it('counts this cycle only and locks through saving', () => {
    const s: ProcessingSnapshot = { jobs: [job('old', 'completed'), job('a','completed'), {...job('b','running'),stage:'saving'}, job('c','waiting')], cycleIds:['a','b','c'], active:true, seconds:6 };
    expect(cycleView(s)).toMatchObject({label:'正在保存 · 2/3',summary:'已完成 1 份 · 等待 1 份',disabled:true});
  });
  it('does not allow a new scan with interrupted or waiting work', () => {
    expect(cycleView({ jobs:[job('a','interrupted'),job('b','waiting')],active:false,seconds:6 })).toMatchObject({resume:true,label:'继续处理',summary:'上次处理未完成 · 剩余 2 份'});
  });
  it('ends after failure and ignores history in the summary', () => {
    expect(cycleView({jobs:[job('old','completed'),job('a','failed')],cycleIds:['a'],active:false,seconds:6})).toMatchObject({label:'扫描录音',disabled:false,summary:'本次完成 0 份 · 失败 1 份'});
  });
  it('keeps scanning locked and supports an empty cycle', () => {
    const s = { jobs:[],cycleIds:[],active:false,seconds:6 };
    expect(cycleView(s,true).disabled).toBe(true);
    expect(cycleView(s).summary).toBe('');
  });
});

 it('reports real transcription progress and switches to verification without completing the cycle', () => {
 const s: ProcessingSnapshot = {jobs:[{id:'a',name:'a',status:'running',stage:'transcribing',seconds:6,error:null,progress:46}],active:true,seconds:6,cycleIds:['a']};
 expect(cycleView(s).label).toBe('正在转写 46% · 1/1');
 s.jobs[0].stage='verifying';s.jobs[0].progress=100;
 expect(cycleView(s).label).toBe('正在校验转写结果… · 1/1');
 expect(cycleView(s).disabled).toBe(true);
 });
