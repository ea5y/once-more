import copy, datetime, json, pathlib, sqlite3, subprocess
from zoneinfo import ZoneInfo
root=pathlib.Path(__file__).resolve().parents[2]
assert not any(p.strip().endswith('/Contents/MacOS/once-more') for p in subprocess.check_output(['ps','-axo','comm'],text=True).splitlines()), 'Quit Once More first'
c=sqlite3.connect(str(pathlib.Path.home()/'Library/Application Support/app.oncemore.desktop/once-more.sqlite3'))
rid='a6b955e9-e335-425a-a78e-f94cf839ef25'
path=c.execute('select path from recordings where id=?',(rid,)).fetchone()[0]
metadata=json.loads(subprocess.check_output([str(root/'src-tauri/binaries/ffprobe'),'-v','quiet','-show_entries','format_tags=creation_time','-of','json',path]))
start=datetime.datetime.fromisoformat(metadata['format']['tags']['creation_time'].replace('Z','+00:00'))
assert start.isoformat()=='2026-11-06T10:31:57+00:00'
assert not c.execute("select 1 from processing_queue where status in ('running','waiting','interrupted')").fetchone()
body=c.execute('select body from v1_library where id=1').fetchone()[0]
old=json.loads(body);new=copy.deepcopy(old);changed=[]
for item in new['items']:
 if item.get('sourceId')!=rid:continue
 dt=(start+datetime.timedelta(seconds=item['start'])).astimezone(ZoneInfo('Asia/Shanghai'))
 item['date']=dt.strftime('%Y-%m-%d');item['time']=dt.strftime('%H:%M:%S');changed.append((item['id'],item['date'],item['time']))
assert len(changed)==16
for a,b in zip(old['items'],new['items']):
 assert {k:v for k,v in a.items() if k not in ('date','time')}=={k:v for k,v in b.items() if k not in ('date','time')}
backup=root/'.local/backups'/('recording-date-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));backup.mkdir(parents=True)
with sqlite3.connect(backup/'before.sqlite3') as dst:c.backup(dst)
with c:
 c.execute('begin immediate')
 assert c.execute('select body from v1_library where id=1').fetchone()[0]==body
 c.execute('update v1_library set body=? where id=1',(json.dumps(new,ensure_ascii=False),))
(backup/'receipt.json').write_text(json.dumps(changed,ensure_ascii=False,indent=2))
print('Backup:',backup);print('Updated:',len(changed));print('Last:',changed[-1])
