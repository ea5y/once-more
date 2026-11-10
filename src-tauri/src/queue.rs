//! Durable, serial automatic processing. UI activation is deliberately a separate batch.
use crate::{err, read_v1_library, setting, transcription, Result, Store};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use tauri::Manager;

#[derive(Default)]
pub struct Runner { active: AtomicBool }
impl Runner { pub fn is_active(&self)->bool {self.active.load(Ordering::SeqCst)} }
#[derive(Serialize, Debug)]
#[serde(rename_all="camelCase")]
pub struct Job { elapsed_seconds:Option<f64>, progress:Option<f64>, id:String, name:String, status:String, stage:String, seconds:Option<f64>, error:Option<String>, batch_id:Option<String>, batch_started:Option<i64>, duration:Option<f64>, clip_count:usize, source_path:String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Snapshot { jobs:Vec<Job>, active:bool, seconds:f64, cycle_ids:Vec<String> }
pub fn initialize(db:&Connection)->Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS processing_timing(recording_id TEXT PRIMARY KEY, started REAL, elapsed REAL); UPDATE processing_timing SET started=NULL WHERE elapsed IS NULL; CREATE TABLE IF NOT EXISTS processing_progress(recording_id TEXT PRIMARY KEY, percent REAL NOT NULL); CREATE TABLE IF NOT EXISTS recording_audio_metadata(path TEXT PRIMARY KEY, modified INTEGER NOT NULL, size INTEGER NOT NULL, duration REAL NOT NULL); CREATE TABLE IF NOT EXISTS processing_task_batches(recording_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, started INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS processing_queue(recording_id TEXT PRIMARY KEY REFERENCES recordings(id), status TEXT NOT NULL, stage TEXT NOT NULL, seconds REAL, error TEXT, payload TEXT);
      UPDATE processing_queue SET status='interrupted',error='上次处理已中断，请手动继续' WHERE status IN ('waiting','running');").map_err(err)
}
fn validate(seconds:f64)->Result<()> { if seconds.is_finite() && seconds>0.0 {Ok(())} else {Err("请输入大于0的停顿秒数".into())} }
fn seconds(db:&Connection)->Result<f64> {
    let value=setting(db,"pause_seconds")?.map(|s|s.parse::<f64>().map_err(err)).transpose()?.unwrap_or(6.0);
    validate(value)?;Ok(value)
}
fn listed(db:&Connection)->Result<Vec<Job>> {
    let library=read_v1_library(db)?;
    let items=library.as_ref().and_then(|v|v["items"].as_array());
    let mut q=db.prepare("SELECT q.recording_id,r.name,q.status,q.stage,q.seconds,q.error,b.batch_id,b.started,COALESCE(t.duration,m.duration),r.path FROM processing_queue q JOIN recordings r ON r.id=q.recording_id LEFT JOIN processing_task_batches b ON b.recording_id=q.recording_id LEFT JOIN local_transcriptions t ON t.recording_id=q.recording_id LEFT JOIN recording_audio_metadata m ON m.path=r.path AND m.modified=r.modified AND m.size=r.size ORDER BY q.rowid").map_err(err)?;
    let rows=q.query_map([],|r| {
        let id:String=r.get(0)?;
        let clip_count=items.map_or(0,|v|v.iter().filter(|i|i["sourceId"]==id).count());
        Ok(Job{elapsed_seconds:db.query_row("SELECT CASE WHEN q.status='waiting' THEN NULL WHEN t.elapsed IS NOT NULL THEN t.elapsed WHEN q.status='running' AND t.started IS NOT NULL THEN MAX(0,?2-t.started) ELSE NULL END FROM processing_timing t JOIN processing_queue q ON q.recording_id=t.recording_id WHERE t.recording_id=?1",params![id,wall_seconds()],|r|r.get(0)).optional()?.flatten(),progress:db.query_row("SELECT percent FROM processing_progress WHERE recording_id=?1",[&id],|r|r.get(0)).optional()?,id,name:r.get(1)?,status:r.get(2)?,stage:r.get(3)?,seconds:r.get(4)?,error:r.get(5)?,batch_id:r.get(6)?,batch_started:r.get(7)?,duration:r.get(8)?,source_path:r.get(9)?,clip_count})
    }).map_err(err)?;
    rows.collect::<std::result::Result<Vec<_>,_>>().map_err(err)
}
fn saved(db:&Connection,id:&str)->Result<bool> {
    Ok(read_v1_library(db)?.as_ref().and_then(|v|v["items"].as_array()).is_some_and(|items|items.iter().any(|i|i["sourceId"]==id)))
}
fn cycle_ids(db:&Connection)->Result<Vec<String>> {
    match setting(db,"processing_cycle")? {
        Some(value)=>serde_json::from_str(&value).map_err(err),
        None=>Ok(listed(db)?.into_iter().filter(|j|matches!(j.status.as_str(),"waiting"|"running"|"interrupted")).map(|j|j.id).collect()),
    }
}
fn store_cycle(db:&Connection,ids:&[String])->Result<()> {
    db.execute("INSERT INTO settings(key,value) VALUES('processing_cycle',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(ids).map_err(err)?]).map_err(err)?;Ok(())
}
#[cfg(test)]
fn enqueue(db:&Connection,ids:&[String])->Result<usize> { enqueue_at(db,ids,seconds(db)?) }
fn enqueue_at(db:&Connection,ids:&[String],pause:f64)->Result<usize> {
    let tx=db.unchecked_transaction().map_err(err)?;let mut count=0;let mut batch=Vec::new();
    for id in ids {
        if saved(&tx,id)? {continue;}
        let added=tx.execute("INSERT OR IGNORE INTO processing_queue(recording_id,status,stage,seconds) VALUES(?1,'waiting','preparing',?2)",params![id,pause]).map_err(err)?;
        count+=added;if added>0 {batch.push(id.clone());}
    }
    let scan:Option<(String,i64)>=tx.query_row("SELECT id,started FROM scan_history WHERE status='succeeded' ORDER BY started DESC,rowid DESC LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
    if let Some((scan_id,started))=scan {for id in &batch {tx.execute("INSERT OR IGNORE INTO processing_task_batches(recording_id,batch_id,started) VALUES(?1,?2,?3)",params![id,scan_id,started]).map_err(err)?;}}
    store_cycle(&tx,&batch)?;tx.commit().map_err(err)?;Ok(count)
}
fn claim(db:&Connection)->Result<Option<String>> {
    let tx=db.unchecked_transaction().map_err(err)?;
    let id:Option<String>=tx.query_row("SELECT recording_id FROM processing_queue WHERE status='waiting' ORDER BY rowid LIMIT 1",[],|r|r.get(0)).optional().map_err(err)?;
    if let Some(ref id)=id {
        tx.execute("INSERT INTO processing_timing VALUES(?1,?2,NULL) ON CONFLICT(recording_id) DO UPDATE SET started=excluded.started,elapsed=NULL",params![id,wall_seconds()]).map_err(err)?;
        tx.execute("DELETE FROM processing_progress WHERE recording_id=?1",[id]).map_err(err)?;
        tx.execute("UPDATE processing_queue SET status='running',seconds=COALESCE(seconds,?1),error=NULL WHERE recording_id=?2",params![seconds(&tx)?,id]).map_err(err)?;
    }
    tx.commit().map_err(err)?;Ok(id)
}
pub(crate) fn retry(db:&Connection,id:&str)->Result<()> {
    let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM resegment_cleanup WHERE recording_id=?1 AND done=0)",[id],|r|r.get(0)).map_err(err)?;
    if pending {return Err("清理未完成，请先继续清理".into());}
    let tx=db.unchecked_transaction().map_err(err)?;
    let unfinished:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM processing_queue WHERE status IN ('waiting','running','interrupted'))",[],|r|r.get(0)).map_err(err)?;
    let mut cycle=if unfinished {cycle_ids(&tx)?} else {Vec::new()};
    if tx.execute("UPDATE processing_queue SET rowid=(SELECT COALESCE(MAX(rowid),0)+1 FROM processing_queue),status='waiting',stage=CASE WHEN stage='cleaning' THEN 'segmenting' ELSE stage END,error=NULL WHERE recording_id=?1 AND status IN ('failed','interrupted')",[id]).map_err(err)?==0 {return Err("任务当前不可重试".into());}
    if !cycle.iter().any(|item|item==id){cycle.push(id.to_string());}store_cycle(&tx,&cycle)?;
    tx.commit().map_err(err)
}
fn stage(db:&Connection,id:&str,value:&str)->Result<()> {
    db.execute("UPDATE processing_queue SET stage=?1 WHERE recording_id=?2",params![value,id]).map_err(err)?;Ok(())
}
fn conversations(preview:&Value)->Result<Vec<Value>> {
    let source=&preview["source"];
    let id=source["id"].as_str().ok_or("缺少录音标识")?;
    let recorded_at=source["recordedAt"].as_f64().filter(|v| v.is_finite()).ok_or("缺少可靠的录音开始时间")?;
    let duration=preview["duration"].as_f64().ok_or("缺少录音时长")?;
    let parts=preview["parts"].as_array().ok_or("缺少分段结果")?;
    parts.iter().enumerate().map(|(index,p)| {
        let start=p["start"].as_f64().ok_or("片段起点无效")?;
        let end=p["end"].as_f64().ok_or("片段终点无效")?;
        if start<0.0 || end<=start || end>duration+0.001 {return Err("片段范围无效".into());}
        let date=chrono::DateTime::from_timestamp_millis(((recorded_at+start)*1000.0).round() as i64).ok_or("录音日期无效")?.with_timezone(&chrono::Local);
        Ok(json!({"id":format!("pause:{id}:{index}"),"sourceId":id,"sourcePath":source["path"],"sourceName":source["name"],"sourceAvailable":true,"sourceDuration":duration,"start":start,"duration":end-start,"date":date.format("%Y-%m-%d").to_string(),"time":date.format("%H:%M:%S").to_string(),"transcript":p["text"],"sourceTranscript":preview["transcript"],"segmentTranscript":p["sentences"],"pauseSeconds":preview["seconds"],"saved":false,"listens":0}))
    }).collect()
}
/// Atomic library insertion + completion receipt; existing source ranges/favorites are never replaced.
fn commit(db:&Connection,id:&str,preview:&Value)->Result<()> {
    if preview["source"]["id"]!=id {return Err("分段来源不匹配".into());}
    let mut incoming=conversations(preview)?;
    if let Some(generation)=crate::resegment::generation(db,id)? {
        for (index,item) in incoming.iter_mut().enumerate() {item["id"]=format!("pause:{id}:{generation}:{index}").into();}
    }
    let tx=db.unchecked_transaction().map_err(err)?;
    let mut library=read_v1_library(&tx)?.unwrap_or_else(||json!({"version":1,"items":[]}));
    let items=library["items"].as_array_mut().ok_or("片段库格式无效")?;
    if !items.iter().any(|i|i["sourceId"]==id) {items.extend(incoming);}
    crate::write_v1_library(&tx,&library)?;
    tx.execute("UPDATE processing_queue SET status='completed',stage='completed',error=NULL,payload=NULL WHERE recording_id=?1",[id]).map_err(err)?;
    tx.commit().map_err(err)
}
/// Preserve automatically inserted items when an older open view saves its own edits.
pub fn preserve_new_items(db:&Connection,incoming:&mut Value)->Result<()> {
    let retired:Vec<String>={
        let mut q=db.prepare("SELECT id FROM retired_clips").map_err(err)?;
        let rows=q.query_map([],|r|r.get(0)).map_err(err)?;
        rows.collect::<std::result::Result<_,_>>().map_err(err)?
    };
    incoming["items"].as_array_mut().ok_or("片段库格式无效")?.retain(|i|!retired.iter().any(|id|i["id"]==*id));
    let current=read_v1_library(db)?;
    let Some(existing)=current.as_ref().and_then(|v|v["items"].as_array()) else {return Ok(())};
    let items=incoming["items"].as_array_mut().ok_or("片段库格式无效")?;
    for item in existing {
        let auto:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM processing_queue WHERE recording_id=?1 AND status='completed')",[item["sourceId"].as_str().unwrap_or("")],|r|r.get(0)).map_err(err)?;
        if auto && !items.iter().any(|i|i["id"]==item["id"]) {items.push(item.clone());}
    }
    Ok(())
}
fn checkpoint(path:&Path,value:&Value)->Result<()> {
    let temporary=path.with_extension("partial");
    let mut f=fs::File::create(&temporary).map_err(err)?;
    f.write_all(value.to_string().as_bytes()).map_err(err)?;f.sync_all().map_err(err)?;
    fs::rename(temporary,path).map_err(err)
}
// Generation identifies clip IDs; it does not by itself mean transcript reuse.
fn validate_transcription_start(db:&Connection,id:&str,generation:Option<&str>)->Result<()> {
    let stage:String=db.query_row("SELECT stage FROM processing_queue WHERE recording_id=?1",[id],|r|r.get(0)).map_err(err)?;
    // Legacy full-clear tasks already queued by the previous release are at preparing.
    if generation.is_some_and(|g| !g.starts_with("fresh-")) && stage!="preparing" && stage!="transcribing" {
        return Err("转写全文不可用，无法继续重新分段".into());
    }
    Ok(())
}

fn process(app:&tauri::AppHandle,id:&str)->Result<()> {
    uuid::Uuid::parse_str(id).map_err(|_|"录音标识无效".to_string())?;
    let store=app.state::<Store>();
    let (path,seconds,payload,done):(String,f64,Option<String>,bool)={
        let db=store.connection.lock().map_err(err)?;
        let row=db.query_row("SELECT r.path,q.seconds,q.payload FROM recordings r JOIN processing_queue q ON q.recording_id=r.id WHERE r.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(err)?;
        (row.0,row.1,row.2,saved(&db,id)?)
    };
    if done {
        let db=store.connection.lock().map_err(err)?;
        db.execute("UPDATE processing_queue SET status='completed',stage='completed',error=NULL WHERE recording_id=?1",[id]).map_err(err)?;return Ok(());
    }
    let root=app.path().app_data_dir().map_err(err)?;
    let work=root.join("transcription-work").join(id);
    let generation={let db=store.connection.lock().map_err(err)?;crate::resegment::generation(&db,id)?};
    let checkpoint_id=generation.as_ref().map(|g|format!("{id}-{g}")).unwrap_or_else(||id.to_owned());
    let saved_preview=root.join("queue-checkpoints").join(format!("{checkpoint_id}.json"));
    let fingerprint=transcription::fingerprint(Path::new(&path))?;
    let cached=payload.map(|s|serde_json::from_str::<Value>(&s).map_err(err)).transpose()?;
    let cached=match cached {Some(v)=>Some(v),None=>if saved_preview.exists(){Some(serde_json::from_slice(&fs::read(&saved_preview).map_err(err)?).map_err(err)?)}else{None}};
    let preview=if let Some(cache)=cached {
        if cache["fingerprint"]!=fingerprint || cache["preview"]["seconds"].as_f64()!=Some(seconds) {return Err("原录音或任务参数与保留结果不一致，未覆盖已有结果".into());}
        cache["preview"].clone()
    } else {
        let complete:bool={let db=store.connection.lock().map_err(err)?;db.query_row("SELECT EXISTS(SELECT 1 FROM local_transcriptions WHERE recording_id=?1 AND phase='completed')",[id],|r|r.get(0)).map_err(err)?};
        if !complete { let db=store.connection.lock().map_err(err)?; validate_transcription_start(&db,id,generation.as_deref())?; }
        if !complete {
            let model=app.state::<Arc<crate::model::ModelManager>>().ready_path()?;
            let resources=app.path().resource_dir().map_err(err)?;
            let binary=transcription::engine(&resources)?;
            let tools=crate::audio::Tools::discover(Some(&resources))?;
            {let db=store.connection.lock().map_err(err)?;stage(&db,id,"preparing")?;}
            let (rows,duration,fp)=transcription::transcribe(&tools,&binary,&model,Path::new(&path),&work,|phase,progress|{let db=store.connection.lock().map_err(err)?;stage(&db,id,phase)?;db.execute("INSERT INTO processing_progress VALUES(?1,?2) ON CONFLICT(recording_id) DO UPDATE SET percent=excluded.percent",params![id,progress]).map_err(err)?;Ok(())})?;
            {let db=store.connection.lock().map_err(err)?;db.execute("INSERT INTO local_transcriptions(recording_id,phase,body,duration,fingerprint) VALUES(?1,'completed',?2,?3,?4) ON CONFLICT(recording_id) DO UPDATE SET phase='completed',error=NULL,body=excluded.body,duration=excluded.duration,fingerprint=excluded.fingerprint",params![id,serde_json::to_string(&rows).map_err(err)?,duration,fp]).map_err(err)?;}
            let _=fs::remove_dir_all(&work);
        }
        {let db=store.connection.lock().map_err(err)?;stage(&db,id,"segmenting")?;}
        let preview=tauri::async_runtime::block_on(crate::pause::preview_pause_segments(app.clone(),id.into(),seconds))?;
        let cache=json!({"fingerprint":fingerprint,"preview":preview});
        fs::create_dir_all(saved_preview.parent().unwrap()).map_err(|e|format!("分段结果写入失败：{e}"))?;checkpoint(&saved_preview,&cache).map_err(|e|format!("分段结果写入失败：{e}"))?;
        {let db=store.connection.lock().map_err(err)?;db.execute("UPDATE processing_queue SET payload=?1,stage='saving' WHERE recording_id=?2",params![cache.to_string(),id]).map_err(err)?;}
        preview
    };
    let db=store.connection.lock().map_err(err)?;stage(&db,id,"saving")?;commit(&db,id,&preview)?;
    let _=fs::remove_file(saved_preview);Ok(())
}
#[tauri::command]
pub fn processing_status(app:tauri::AppHandle)->Result<Snapshot> {
    let state=app.state::<Store>();let db=state.connection.lock().map_err(err)?;
    Ok(Snapshot{jobs:listed(&db)?,active:app.state::<Runner>().active.load(Ordering::SeqCst),seconds:seconds(&db)?,cycle_ids:cycle_ids(&db)?})
}
#[tauri::command]
pub fn set_processing_seconds(seconds:f64,state:tauri::State<Store>)->Result<()> {
    validate(seconds)?;let db=state.connection.lock().map_err(err)?;
    db.execute("INSERT INTO settings(key,value) VALUES('pause_seconds',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[seconds.to_string()]).map_err(err)?;Ok(())
}
#[tauri::command]
pub fn enqueue_processing(state:tauri::State<Store>, retry_id:Option<String>)->Result<usize> {
    let db=state.connection.lock().map_err(err)?;
    let folder=if let Some(id)=retry_id {db.query_row("SELECT source FROM scan_history WHERE id=?1",[id],|r|r.get::<_,String>(0)).map_err(err)?} else {db.query_row("SELECT source FROM scan_history WHERE status='succeeded' ORDER BY started DESC,rowid DESC LIMIT 1",[],|r|r.get::<_,String>(0)).map_err(err)?};
    let mut q=db.prepare("SELECT id,path FROM recordings ORDER BY modified,id").map_err(err)?;
    let rows=q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(err)?;
    let mut ids=Vec::new();for row in rows {let (id,path)=row.map_err(err)?;if Path::new(&path).starts_with(&folder)&&Path::new(&path).is_file(){ids.push(id);}}
    let pause=setting(&db,"scan_pause_snapshot")?.map(|s|s.parse::<f64>().map_err(err)).transpose()?.unwrap_or(seconds(&db)?);
    enqueue_at(&db,&ids,pause)
}
#[tauri::command]
pub async fn retry_processing(id:String,app:tauri::AppHandle)->Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<Store>();let _operation=state.source_operation.lock().map_err(err)?;
        let db=state.connection.lock().map_err(err)?;
        let cleaning:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM processing_queue WHERE recording_id=?1 AND stage='cleaning')",[&id],|r|r.get(0)).map_err(err)?;
        if cleaning {crate::resegment::resume(&db,&id)} else {retry(&db,&id)}
    }).await.map_err(err)?
}
#[tauri::command]
pub fn run_processing(app:tauri::AppHandle)->Result<()> {
    if app.state::<Runner>().active.swap(true,Ordering::SeqCst) {return Ok(());}
    if app.state::<transcription::Worker>().0.swap(true,Ordering::SeqCst) {app.state::<Runner>().active.store(false,Ordering::SeqCst);return Err("已有录音正在处理中，请稍后继续".into());}
    std::thread::spawn(move || {
        struct Release(tauri::AppHandle);
        impl Drop for Release {fn drop(&mut self){self.0.state::<transcription::Worker>().0.store(false,Ordering::SeqCst);self.0.state::<Runner>().active.store(false,Ordering::SeqCst);}}
        let _release=Release(app.clone());
        loop {
            if crate::processes::closing() { break; }
            let state=app.state::<Store>();
            // A missing model leaves tasks waiting without freezing their future pause parameter.
            let next=(||->Result<Option<String>>{
                let db=state.connection.lock().map_err(err)?;
                let id:Option<String>=db.query_row("SELECT recording_id FROM processing_queue WHERE status='waiting' ORDER BY rowid LIMIT 1",[],|r|r.get(0)).optional().map_err(err)?;
                let Some(id)=id else{return Ok(None)};
                let reusable:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM local_transcriptions WHERE recording_id=?1 AND phase='completed')",[&id],|r|r.get(0)).map_err(err)?;
                if !reusable && app.state::<Arc<crate::model::ModelManager>>().ready_path().is_err() {
                    db.execute("UPDATE processing_queue SET error='请先准备本地转写模型' WHERE recording_id=?1",[id]).map_err(err)?;return Ok(None);
                }
                claim(&db)
            })();
            let id=match next {Ok(Some(id))=>id,_=>break};
            let started=std::time::Instant::now();
            let result=process(&app,&id);
            {let Ok(db)=state.connection.lock() else{break};
             if db.execute("UPDATE processing_timing SET elapsed=?1,started=NULL WHERE recording_id=?2",params![started.elapsed().as_secs_f64(),id]).is_err(){break;}}
            if let Err(error)=result {
                if crate::processes::closing() { break; }
                let Ok(db)=state.connection.lock() else{break};
                if db.execute("UPDATE processing_queue SET status='failed',error=?1 WHERE recording_id=?2",params![error,id]).is_err(){break;}
            }
        }
    });Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db()->Connection {
        let db=Connection::open_in_memory().unwrap();crate::initialize(&db).unwrap();crate::transcription::initialize(&db).unwrap();
        for id in ["a","b","c"] {db.execute("INSERT INTO recordings VALUES(?1,?2,?1,0,1)",params![id,format!("/{id}")]).unwrap();}db
    }
    fn preview(id:&str)->Value {json!({"source":{"id":id,"path":format!("/{id}"),"name":"test.wav","modified":99999,"recordedAt":0},"seconds":6.0,"duration":2.0,"transcript":[{"start":0.0,"end":2.0,"text":"第一句话"}],"parts":[{"start":0.0,"end":2.0,"text":["第一句话"],"sentences":[{"start":0.0,"end":2.0,"text":"第一句话"}]}]})}
    #[test]
    fn resegment_cleans_before_queueing_and_uses_new_ids() {
        let db=db();
        let path=std::env::temp_dir().join(format!("once-resegment-{}",uuid::Uuid::new_v4()));
        fs::write(&path,b"original").unwrap();
        db.execute("UPDATE recordings SET path=?1 WHERE id='a'",[path.to_str().unwrap()]).unwrap();
        let fp=transcription::fingerprint(&path).unwrap();
        db.execute("INSERT INTO local_transcriptions(recording_id,phase,body,duration,fingerprint) VALUES('a','completed','[]',2,?1)",[fp]).unwrap();
        enqueue(&db,&["a".into(),"b".into()]).unwrap();commit(&db,"a",&preview("a")).unwrap();
        let mut old=read_v1_library(&db).unwrap().unwrap();
        crate::resegment::begin(&db,"a",8.0).unwrap();
        assert!(!saved(&db,"a").unwrap());
        assert!(crate::resegment::begin(&db,"a",9.0).is_err());
        assert_eq!(seconds(&db).unwrap(),6.0);
        assert_eq!(claim(&db).unwrap().as_deref(),Some("b"));
        assert_eq!(claim(&db).unwrap().as_deref(),Some("a"));
        assert_eq!(listed(&db).unwrap().iter().find(|j|j.id=="a").unwrap().seconds,Some(8.0));
        commit(&db,"a",&preview("a")).unwrap();
        let fresh=read_v1_library(&db).unwrap().unwrap();assert_ne!(fresh["items"][0]["id"],old["items"][0]["id"]);
        preserve_new_items(&db,&mut old).unwrap();assert_eq!(old,fresh);
        assert_eq!(fs::read(&path).unwrap(),b"original");fs::remove_file(path).unwrap();
    }
    #[test]
    fn cleanup_pending_cannot_be_retried_into_processing() {
        let db=db();enqueue(&db,&["a".into()]).unwrap();
        db.execute("UPDATE processing_queue SET status='failed',stage='cleaning'",[]).unwrap();
        db.execute("INSERT INTO resegment_cleanup VALUES('a','/pending',0)",[]).unwrap();
        assert!(retry(&db,"a").is_err());assert!(claim(&db).unwrap().is_none());
    }
    #[test]
    fn batch_metadata_survives_retry_and_legacy_stays_unknown() {
        let db=db();
        db.execute("INSERT INTO scan_history(id,started,status) VALUES('scan-one',100,'succeeded')",[]).unwrap();
        enqueue(&db,&["a".into()]).unwrap();
        db.execute("UPDATE processing_queue SET status='failed' WHERE recording_id='a'",[]).unwrap();
        db.execute("INSERT INTO scan_history(id,started,status) VALUES('scan-two',200,'succeeded')",[]).unwrap();
        enqueue(&db,&["b".into()]).unwrap();retry(&db,"a").unwrap();
        db.execute("INSERT INTO recording_audio_metadata VALUES('/a',0,1,24.5)",[]).unwrap();
        let jobs=listed(&db).unwrap();let a=jobs.iter().find(|j|j.id=="a").unwrap();
        assert_eq!(a.batch_id.as_deref(),Some("scan-one"));assert_eq!(a.duration,Some(24.5));
        assert_eq!(jobs.iter().find(|j|j.id=="b").unwrap().batch_started,Some(200));
        db.execute("INSERT INTO processing_queue(recording_id,status,stage) VALUES('c','completed','completed')",[]).unwrap();
        assert!(listed(&db).unwrap().iter().find(|j|j.id=="c").unwrap().batch_id.is_none());
    }
    #[test]
    fn retries_join_tail_and_keep_enqueued_parameters() {
        let db=db();assert_eq!(enqueue(&db,&["a".into(),"b".into()]).unwrap(),2);
        assert_eq!(claim(&db).unwrap().as_deref(),Some("a"));
        db.execute("INSERT INTO settings VALUES('pause_seconds','9')",[]).unwrap();
        db.execute("UPDATE processing_queue SET status='failed' WHERE recording_id='a'",[]).unwrap();
        retry(&db,"a").unwrap();
        assert_eq!(claim(&db).unwrap().as_deref(),Some("b"));
        assert_eq!(claim(&db).unwrap().as_deref(),Some("a"));
        assert!(listed(&db).unwrap().iter().all(|j|j.seconds==Some(6.0)));
        assert_eq!(cycle_ids(&db).unwrap(),vec!["a","b"]);
        assert!(retry(&db,"a").is_err());
        assert!(validate(0.0).is_err());assert!(validate(f64::NAN).is_err());
    }
    #[test]
    fn multiple_retries_extend_cycle_without_old_history() {
        let db=db();enqueue(&db,&["a".into(),"b".into(),"c".into()]).unwrap();
        db.execute("UPDATE processing_queue SET status='failed'",[]).unwrap();
        retry(&db,"b").unwrap();retry(&db,"a").unwrap();
        assert_eq!(cycle_ids(&db).unwrap(),vec!["b","a"]);
        assert_eq!(claim(&db).unwrap().as_deref(),Some("b"));
        assert_eq!(claim(&db).unwrap().as_deref(),Some("a"));
        assert!(retry(&db,"a").is_err());
        assert_eq!(cycle_ids(&db).unwrap(),vec!["b","a"]);
    }
    #[test]
    fn restart_marks_waiting_and_running_interrupted_preserving_checkpoints() {
        let path=std::env::temp_dir().join(format!("once-queue-{}.sqlite3",uuid::Uuid::new_v4()));
        {
            let db=Connection::open(&path).unwrap();crate::initialize(&db).unwrap();crate::transcription::initialize(&db).unwrap();
            for id in ["a","b"]{db.execute("INSERT INTO recordings VALUES(?1,?2,?1,0,1)",params![id,format!("/{id}")]).unwrap();}
            enqueue(&db,&["a".into(),"b".into()]).unwrap();claim(&db).unwrap();
            db.execute("UPDATE processing_queue SET stage='saving',payload='checkpoint' WHERE recording_id='a'",[]).unwrap();
        }
        let db=Connection::open(&path).unwrap();crate::initialize(&db).unwrap();crate::transcription::initialize(&db).unwrap();
        assert!(listed(&db).unwrap().iter().all(|j|j.status=="interrupted"));
        assert_eq!(claim(&db).unwrap(),None);
        assert_eq!(db.query_row("SELECT payload FROM processing_queue WHERE recording_id='a'",[],|r|r.get::<_,String>(0)).unwrap(),"checkpoint");
        retry(&db,"a").unwrap();assert_eq!(claim(&db).unwrap().as_deref(),Some("a"));
        assert_eq!(listed(&db).unwrap().iter().find(|j|j.id=="a").unwrap().stage,"saving");
        drop(db);fs::remove_file(path).unwrap();
    }
    #[test]
    fn save_and_receipt_are_atomic_retry_does_not_duplicate_or_overwrite() {
        let db=db();enqueue(&db,&["a".into()]).unwrap();claim(&db).unwrap();
        db.execute_batch("CREATE TRIGGER fail_completion BEFORE UPDATE ON processing_queue WHEN NEW.status='completed' BEGIN SELECT RAISE(FAIL,'disk failure'); END;").unwrap();
        assert!(commit(&db,"a",&preview("a")).is_err());
        assert!(read_v1_library(&db).unwrap().is_none());
        db.execute_batch("DROP TRIGGER fail_completion;").unwrap();
        commit(&db,"a",&preview("a")).unwrap();
        let mut library=read_v1_library(&db).unwrap().unwrap();library["items"][0]["saved"]=true.into();library["items"][0]["start"]=0.5.into();
        crate::write_v1_library(&db,&library).unwrap();
        commit(&db,"a",&preview("a")).unwrap();
        assert_eq!(read_v1_library(&db).unwrap().unwrap(),library);
        assert_eq!(enqueue(&db,&["a".into()]).unwrap(),0);
        assert!(retry(&db,"a").is_err());
    }
    #[test]
    fn stale_view_save_keeps_new_queue_items_and_preserves_edits() {
        let db=db();enqueue(&db,&["a".into()]).unwrap();commit(&db,"a",&preview("a")).unwrap();
        let mut stale=json!({"version":1,"items":[{"id":"manual","sourceId":"other","saved":true}]});
        preserve_new_items(&db,&mut stale).unwrap();assert_eq!(stale["items"].as_array().unwrap().len(),2);
        stale["items"][1]["saved"]=true.into();preserve_new_items(&db,&mut stale).unwrap();
        assert_eq!(stale["items"].as_array().unwrap().len(),2);assert_eq!(stale["items"][1]["saved"],true);
    }
    #[test]
    fn checkpoint_roundtrip_and_source_validation() {
        let path=std::env::temp_dir().join(format!("once-queue-checkpoint-{}.json",uuid::Uuid::new_v4()));
        let value=json!({"fingerprint":"same-source","preview":preview("a")});checkpoint(&path,&value).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),value);fs::remove_file(path).unwrap();
        let db=db();enqueue(&db,&["a".into()]).unwrap();assert!(commit(&db,"a",&preview("b")).is_err());
        let mut bad=preview("a");bad["parts"][0]["end"]=3.0.into();assert!(commit(&db,"a",&bad).is_err());
    }
}

#[cfg(test)]
mod clear_restart_tests {
 use super::*;
 #[test]
 fn cleared_recording_enters_real_transcription_gate_after_enqueue_and_retry() {
  let db=Connection::open_in_memory().unwrap();crate::initialize(&db).unwrap();
  db.execute("INSERT INTO recordings VALUES('a','/fixture.wav','fixture',0,1)",[]).unwrap();
  assert_eq!(enqueue_at(&db,&["a".into()],6.0).unwrap(),1);
  assert_eq!(claim(&db).unwrap().as_deref(),Some("a"));
  assert!(validate_transcription_start(&db,"a",Some("fresh-new-generation")).is_ok());
  db.execute("UPDATE processing_queue SET status='failed',stage='preparing'",[]).unwrap();
  retry(&db,"a").unwrap();claim(&db).unwrap();
  assert!(validate_transcription_start(&db,"a",Some("legacy-clear-uuid")).is_ok());
  db.execute("UPDATE processing_queue SET stage='segmenting'",[]).unwrap();
  assert!(validate_transcription_start(&db,"a",Some("resegment-uuid")).is_err());
 }
}

fn wall_seconds()->f64 {std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs_f64()}

#[cfg(test)]
mod timing_tests {
 use super::*;
 #[test] fn queue_does_not_time_and_retry_resets_when_claimed() {
 let db=Connection::open_in_memory().unwrap();crate::initialize(&db).unwrap();crate::transcription::initialize(&db).unwrap();
 db.execute("INSERT INTO recordings VALUES('a','/fixture','test',0,1)",[]).unwrap();
 enqueue_at(&db,&["a".into()],6.0).unwrap();assert_eq!(listed(&db).unwrap()[0].elapsed_seconds,None);
 claim(&db).unwrap();assert!(listed(&db).unwrap()[0].elapsed_seconds.unwrap()<2.0);
 db.execute("UPDATE processing_timing SET elapsed=763,started=NULL",[]).unwrap();db.execute("UPDATE processing_queue SET status='failed'",[]).unwrap();
 assert_eq!(listed(&db).unwrap()[0].elapsed_seconds,Some(763.0));
 retry(&db,"a").unwrap();assert_eq!(listed(&db).unwrap()[0].elapsed_seconds,None);
 claim(&db).unwrap();assert!(listed(&db).unwrap()[0].elapsed_seconds.unwrap()<2.0);
 db.execute("UPDATE processing_timing SET elapsed=42,started=NULL",[]).unwrap();db.execute("UPDATE processing_queue SET status='completed'",[]).unwrap();
 initialize(&db).unwrap();assert_eq!(listed(&db).unwrap()[0].elapsed_seconds,Some(42.0));
 }
}
