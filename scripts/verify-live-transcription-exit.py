"""Armed fault test: only kill the desktop while the named fixture is transcribing."""
import sqlite3, subprocess, os, signal, time, json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
exe=str(root/'src-tauri/target/debug/once-more')
db=Path.home()/'Library/Application Support/app.oncemore.desktop/once-more.sqlite3'
evidence=root/'.local/verification/live-force-exit.json'
limit=time.monotonic()+180
while time.monotonic()<limit:
 c=sqlite3.connect(f'file:{db}?mode=ro',uri=True)
 row=c.execute("select r.id,q.status,q.stage from recordings r join processing_queue q on q.recording_id=r.id where r.name='queue-force-live.m4a'").fetchone();c.close()
 if row and row[1:] == ('running','transcribing'):
  entries=[]
  for line in subprocess.check_output(['ps','-axo','pid,ppid,command'],text=True).splitlines()[1:]:
   parts=line.strip().split(None,2)
   if len(parts)==3: entries.append((int(parts[0]),int(parts[1]),parts[2]))
  workers=[p for p in entries if '/binaries/whisper-cli ' in p[2] and row[0] in p[2] and not p[2].startswith(exe+' ')]
  if workers:
   worker=workers[0]; supervisor=next(p for p in entries if p[0]==worker[1]); app=next(p for p in entries if p[0]==supervisor[1])
   assert app[2]==exe and supervisor[2].startswith(exe+' --once-more-processing-child ')
   os.kill(app[0],signal.SIGKILL)
   def gone(pid):
    try: os.kill(pid,0); return False
    except ProcessLookupError:return True
   end=time.monotonic()+5
   while time.monotonic()<end and not all(gone(p[0]) for p in [app,supervisor,worker]):time.sleep(.02)
   assert all(gone(p[0]) for p in [app,supervisor,worker]),'process survived'
   c=sqlite3.connect(f'file:{db}?mode=ro',uri=True)
   after=c.execute('select status,stage,seconds from processing_queue where recording_id=?',[row[0]]).fetchone();c.close()
   assert after[0]=='running' and after[1]=='transcribing', 'task completed before kill'
   result={'recordingId':row[0],'before':row,'afterKill':after,'appPid':app[0],'supervisorPid':supervisor[0],'workerPid':worker[0],'allExited':True}
   evidence.write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True);break
 time.sleep(.1)
else: raise SystemExit('Timed out; no application was killed')
