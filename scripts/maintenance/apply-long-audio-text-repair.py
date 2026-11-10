"""One-off, backed-up text repair. Run only after closing Once More."""
import argparse, copy, datetime, json, pathlib, sqlite3, subprocess
from zoneinfo import ZoneInfo
parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
root=pathlib.Path(__file__).resolve().parents[2]
base=root/'.local/verification/long-audio/windowed-full'
plan=json.loads((base/'repair-plan.json').read_text());rows=json.loads((base/'corrected-segments.json').read_text())
rid='a6b955e9-e335-425a-a78e-f94cf839ef25'
db=pathlib.Path.home()/'Library/Application Support/app.oncemore.desktop/once-more.sqlite3'
if args.apply:
    processes=subprocess.check_output(['ps','-axo','comm'],text=True).splitlines()
    assert not any(p.strip().endswith('/Contents/MacOS/once-more') for p in processes),'Close Once More before applying'
c=sqlite3.connect('file:'+str(db)+('?mode=rw' if args.apply else '?mode=ro'),uri=True)
old_body=c.execute('select body from v1_library where id=1').fetchone()[0];old=json.loads(old_body);library=copy.deepcopy(old)
source=pathlib.Path(c.execute('select path from recordings where id=?',(rid,)).fetchone()[0]);st=source.stat()
fp=f'{st.st_size}:SystemTime {{ tv_sec: {st.st_mtime_ns//1000000000}, tv_nsec: {st.st_mtime_ns%1000000000} }}'
assert fp==plan['sourceFingerprint'],'Source changed'
assert not c.execute("select 1 from processing_queue where status in ('running','waiting','interrupted')").fetchone(),'Processing is active'
parts=plan['preview']['parts'];indices=sorted([i for i,x in enumerate(library['items']) if x.get('sourceId')==rid],key=lambda i:library['items'][i]['start'])
assert len(indices)==len(parts)==16
aligned=[r for p in parts for r in p['sentences']];assert len(aligned)==len(rows)==927
for i,p in zip(indices,parts):
    item=library['items'][i]
    assert item['pauseSeconds']==6 and abs(item['start']-p['start'])<.001 and abs(item['start']+item['duration']-p['end'])<.001,'Range changed'
    assert item['sourcePath']==str(source)
    item['transcript']=p['text'];item['segmentTranscript']=p['sentences'];item['sourceTranscript']=aligned
for i,(a,b) in enumerate(zip(old['items'],library['items'])):
    keys={'transcript','segmentTranscript','sourceTranscript'} if i in indices else set()
    assert {k:v for k,v in a.items() if k not in keys}=={k:v for k,v in b.items() if k not in keys},'Unrelated fields changed'
print('Validated text-only update: 16 clips, 927 rows; IDs, ranges, favorites, extractions and listens preserved.')
if args.apply:
    backup=root/'.local/backups'/('long-audio-text-repair-'+datetime.datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True,exist_ok=False)
    with sqlite3.connect(backup/'before.sqlite3') as target:c.backup(target)
    (backup/'library-before.json').write_text(old_body)
    with c:
        c.execute('begin immediate')
        assert c.execute('select body from v1_library where id=1').fetchone()[0]==old_body,'Library changed during backup'
        old_transcript=c.execute('select body,fingerprint from local_transcriptions where recording_id=?',(rid,)).fetchone()
        assert old_transcript and old_transcript[1]==fp
        (backup/'transcription-before.json').write_text(old_transcript[0])
        assert c.execute('update local_transcriptions set body=?,phase=\'completed\',error=NULL where recording_id=?',(json.dumps(rows,ensure_ascii=False),rid)).rowcount==1
        c.execute('update v1_library set body=? where id=1',(json.dumps(library,ensure_ascii=False),))
    assert json.loads(c.execute('select body from v1_library where id=1').fetchone()[0])==library
    (backup/'receipt.json').write_text(json.dumps({'sourceId':rid,'updatedClips':16,'recognizedRows':927,'preservedNonTextFields':True},indent=2))
    print('Applied. Backup:',backup)
