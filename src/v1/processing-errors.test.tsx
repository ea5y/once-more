import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProcessingHistory from './ProcessingHistory';
it('renders safe task messages with stage-specific retry buttons', () => {
  const html = renderToStaticMarkup(<ProcessingHistory snapshot={{ active: false, seconds: 6, jobs: [
    { id: 'a', name: '录音一', status: 'failed', stage: 'segmenting', seconds: 6, error: '分段结果写入失败：Is a directory (os error 21)' },
    { id: 'b', name: '录音二', status: 'failed', stage: 'saving', seconds: 6, error: 'SQLITE error' },
    { id: 'c', name: '录音三', status: 'interrupted', stage: 'transcribing', seconds: 6, error: null },
  ] }} onRefresh={async () => {}} onClose={() => {}} />);
  expect(html).toContain('无法保存分段处理结果，请重试。');
  expect(html).toContain('片段记录未保存成功，请重试保存。');
  expect(html).toContain('上次处理未完成');
  expect(html).toContain('>重试</button>');
  expect(html).toContain('>重试</button>');
  expect(html).toContain('>继续</button>');
  expect(html).not.toMatch(/Is a directory|os error|SQLITE|结果已保留/);
});

it('groups known batches newest first and keeps legacy tasks honest', async () => {
  const { groupJobs, durationText } = await import('./ProcessingHistory');
  const base = { status: 'completed', stage: 'completed', seconds: 6, error: null };
  const groups = groupJobs([
    { ...base, id:'old', name:'old', batchId:'one', batchStarted:10 },
    { ...base, id:'legacy', name:'legacy' },
    { ...base, id:'new', name:'new', batchId:'two', batchStarted:20 },
    { ...base, id:'again', name:'again', batchId:'one', batchStarted:10 },
  ]);
  expect(groups.map(g => g.id)).toEqual(['two','one','legacy']);
  expect(groups[1].jobs.map(j => j.id)).toEqual(['old','again']);
  expect(durationText(null)).toBe('时长待读取');
  expect(durationText(245)).toBe('04:05');
});

it('provides details for every status without a fabricated percentage', () => {
  const html = renderToStaticMarkup(<ProcessingHistory snapshot={{active:true,seconds:6,jobs:[
    {id:'a',name:'等待录音',status:'waiting',stage:'preparing',seconds:6,error:null},
    {id:'b',name:'正在录音',status:'running',stage:'transcribing',seconds:6,error:null},
    {id:'c',name:'完成录音',status:'completed',stage:'completed',seconds:6,error:null,duration:24,clipCount:2},
  ]}} onRefresh={async()=>{}} onClose={()=>{}} />);
  expect(html.match(/>查看详情</g)).toHaveLength(3);
  expect(html).toContain('已生成 2 个片段');
  expect(html).toContain('00:24');
  expect(html).not.toContain('aria-valuenow');
});
