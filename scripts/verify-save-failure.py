"""Scoped transaction fault; only the named fixture's completion is rejected."""
import sqlite3,time,json,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[1];base=Path.home()/'Library/Application Support/app.oncemore.desktop';db=base/'once-more.sqlite3'
name='queue-save-failure.m4a';trigger='once_more_verify_save_failure';installed=False
try:
 with sqlite3.connect(db) as c:
  assert not c.execute('select 1 from sqlite_master where name=?',(trigger,)).fetchone()
  c.execute("""CREATE TRIGGER once_more_verify_save_failure BEFORE UPDATE OF status ON processing_queue
  WHEN NEW.status='completed' AND NEW.recording_id IN (SELECT id FROM recordings WHERE name='queue-save-failure.m4a')
  BEGIN SELECT RAISE(ABORT,'测试：保存确认失败，请重试'); END""")
 installed=True
 print('故障已就绪，仅针对queue-save-failure.m4a',flush=True)
 limit=time.monotonic()+180
 while time.monotonic()<limit:
  with sqlite3.connect(db) as c:
   row=c.execute('select q.recording_id,q.status,q.stage,q.seconds,q.error,q.payload from processing_queue q join recordings r on r.id=q.recording_id where r.name=?',(name,)).fetchone()
   if row and row[1]=='failed':
    a=json.loads(c.execute('select body from v1_library where id=1').fetchone()[0]);break
  time.sleep(.1)
 else:raise RuntimeError('No expected failure')
 rid,status,stage,seconds,error,payload=row
 assert stage=='saving' and payload and seconds==6
 assert not any(i.get('sourceId')==rid for i in a['items'])
 checkpoint=base/'queue-checkpoints'/f'{rid}.json';assert checkpoint.exists()
 result={'id':rid,'status':status,'stage':stage,'seconds':seconds,'error':error,'libraryCount':len(a['items']),'sourceParts':0,'payload':json.loads(payload),'checkpointHash':hashlib.sha256(checkpoint.read_bytes()).hexdigest()}
 (root/'.local/verification/save-failure.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 print(json.dumps({k:v for k,v in result.items() if k!='payload'},ensure_ascii=False),flush=True)
finally:
 if installed:
  with sqlite3.connect(db) as c:c.execute('DROP TRIGGER once_more_verify_save_failure')
