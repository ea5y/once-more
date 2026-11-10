"""Inject only a per-fixture checkpoint write failure; never touch other jobs."""
import sqlite3,time,json,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[1];base=Path.home()/'Library/Application Support/app.oncemore.desktop';db=base/'once-more.sqlite3'
def query(sql,args=()):
 with sqlite3.connect(f'file:{db}?mode=ro',uri=True) as c:return c.execute(sql,args).fetchone()
limit=time.monotonic()+180;obstruction=None
try:
 while time.monotonic()<limit:
  row=query("select r.id,q.status,q.stage from recordings r join processing_queue q on q.recording_id=r.id where r.name='queue-segment-failure.m4a'")
  if row:
   rid=row[0]
   assert row[1] in ('waiting','running') and row[2] in ('preparing','transcribing'),'too late to inject'
   obstruction=base/'queue-checkpoints'/f'{rid}.partial'
   obstruction.parent.mkdir(exist_ok=True);obstruction.mkdir()
   break
  time.sleep(.02)
 else:raise RuntimeError('fixture not scanned')
 while time.monotonic()<limit:
  row=query('select status,stage,seconds,error from processing_queue where recording_id=?',(rid,))
  if row[0]=='failed':break
  time.sleep(.1)
 assert row[0:2]==('failed','segmenting'),row
 transcript=query('select phase,body,fingerprint from local_transcriptions where recording_id=?',(rid,))
 assert transcript[0]=='completed'
 result={'id':rid,'failure':row,'transcriptHash':hashlib.sha256(transcript[1].encode()).hexdigest(),'fingerprint':transcript[2],'workRemoved':not (base/'transcription-work'/rid).exists()}
 (root/'.local/verification/segment-checkpoint-failure.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False),flush=True)
finally:
 if obstruction is not None:obstruction.rmdir()
