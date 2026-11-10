import { it, expect } from 'vitest';
import { elapsedText, type ProcessingJob } from './ProcessingHistory';
it('hides unknown and queue time; keeps finished attempt duration', () => {
 const job: ProcessingJob={id:'a',name:'a',status:'running',stage:'preparing',seconds:6,error:null};
 expect(elapsedText(job)).toBe('');
 job.elapsedSeconds=763;expect(elapsedText(job)).toBe('已耗时 12:43');
 job.status='completed';expect(elapsedText(job)).toBe('耗时 12:43');
 job.status='failed';expect(elapsedText(job)).toBe('已耗时 12:43');
 job.status='waiting';expect(elapsedText(job)).toBe('');
});
