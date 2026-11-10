//! Durable cleanup foundation. UI/queue entry points are connected separately.
use crate::{err, read_v1_library, Result};
use rusqlite::{params, Connection};
use std::{fs, path::Path};

pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS resegment_cleanup(recording_id TEXT NOT NULL, path TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(recording_id,path));
      CREATE TABLE IF NOT EXISTS extraction_files(path TEXT PRIMARY KEY, recording_id TEXT NOT NULL, clip_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retired_clips(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS resegment_runs(recording_id TEXT PRIMARY KEY, generation TEXT NOT NULL);").map_err(err)
}

// Missing paths are already cleaned; all existing targets must be ordinary files.
fn validate_target(path: &Path, protected: &[String]) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(err(e)),
    };
    if !metadata.file_type().is_file() { return Err("清理目标不是普通文件，已停止".into()); }
    let canonical = fs::canonicalize(path).map_err(err)?;
    for other in protected {
        if canonical == Path::new(other) || fs::canonicalize(other).ok().as_ref() == Some(&canonical) {
            return Err("清理目标仍被原录音或其他片段引用，已停止".into());
        }
        #[cfg(unix)]
        if let Ok(other_meta) = fs::metadata(other) {
            use std::os::unix::fs::MetadataExt;
            if metadata.dev() == other_meta.dev() && metadata.ino() == other_meta.ino() {
                return Err("清理目标与保留文件共用内容，已停止".into());
            }
        }
    }
    Ok(())
}

/// Persist the entire plan and retired IDs before removing any file.
/// Caller must serialize source operations and validate task/source/transcript first.
#[allow(dead_code)]
pub fn prepare(db: &Connection, id: &str) -> Result<()> {
    prepare_inner(db, id, None)
}

fn prepare_inner(db: &Connection, id: &str, seconds: Option<f64>) -> Result<()> {
    let tx = db.unchecked_transaction().map_err(err)?;
    if let Some(seconds) = seconds {
        let generation = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO resegment_runs VALUES(?1,?2) ON CONFLICT(recording_id) DO UPDATE SET generation=excluded.generation",params![id,generation]).map_err(err)?;
        tx.execute("UPDATE processing_queue SET status='failed',stage='cleaning',seconds=?1,error='清理未完成，请重试',payload=NULL WHERE recording_id=?2",params![seconds,id]).map_err(err)?;
    }
    let mut library = read_v1_library(&tx)?.unwrap_or_else(|| serde_json::json!({"version":1,"items":[]}));
    let items = library["items"].as_array_mut().ok_or("片段库格式无效")?;
    let mut protected: Vec<String> = {
        let mut q = tx.prepare("SELECT path FROM recordings").map_err(err)?;
        let rows = q.query_map([], |r| r.get(0)).map_err(err)?;
        rows.collect::<std::result::Result<_,_>>().map_err(err)?
    };
    protected.extend(registered_other_paths(&tx,id)?);
    protected.extend(items.iter().filter(|i| i["sourceId"] != id).filter_map(|i| i["clipPath"].as_str().map(str::to_owned)));
    let registered: Vec<String> = {
        let mut q=tx.prepare("SELECT path FROM extraction_files WHERE recording_id=?1").map_err(err)?;
        let rows=q.query_map([id],|r|r.get(0)).map_err(err)?;
        rows.collect::<std::result::Result<_,_>>().map_err(err)?
    };
    for path in registered {
        validate_target(Path::new(&path), &protected)?;
        tx.execute("INSERT INTO resegment_cleanup(recording_id,path) VALUES(?1,?2) ON CONFLICT(recording_id,path) DO UPDATE SET done=0",params![id,path]).map_err(err)?;
    }
    for item in items.iter().filter(|i| i["sourceId"] == id) {
        let clip_id = item["id"].as_str().ok_or("片段标识无效")?;
        if let Some(path) = item["clipPath"].as_str() {
            validate_target(Path::new(path), &protected)?;
            tx.execute("INSERT INTO resegment_cleanup(recording_id,path) VALUES(?1,?2) ON CONFLICT(recording_id,path) DO UPDATE SET done=0", params![id,path]).map_err(err)?;
        }
        tx.execute("INSERT OR IGNORE INTO retired_clips(id) VALUES(?1)", [clip_id]).map_err(err)?;
    }
    items.retain(|i| i["sourceId"] != id);
    crate::write_v1_library(&tx, &library)?;
    tx.commit().map_err(err)
}

/// Each success is checkpointed. Retrying after interruption skips finished work.
#[allow(dead_code)]
pub fn clean(db: &Connection, id: &str) -> Result<()> {
    let paths: Vec<String> = {
        let mut q = db.prepare("SELECT path FROM resegment_cleanup WHERE recording_id=?1 AND done=0 ORDER BY path").map_err(err)?;
        let rows = q.query_map([id], |r|r.get(0)).map_err(err)?;
        rows.collect::<std::result::Result<_,_>>().map_err(err)?
    };
    let mut protected: Vec<String> = {
        let mut q = db.prepare("SELECT path FROM recordings").map_err(err)?;
        let rows = q.query_map([], |r|r.get(0)).map_err(err)?;
        rows.collect::<std::result::Result<_,_>>().map_err(err)?
    };
    if let Some(library) = read_v1_library(db)? {
        if let Some(items) = library["items"].as_array() {
            protected.extend(items.iter().filter_map(|i|i["clipPath"].as_str().map(str::to_owned)));
        }
    }
    protected.extend(registered_other_paths(db,id)?);
    for path in paths {
        validate_target(Path::new(&path), &protected)?;
        match fs::remove_file(&path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("清理未完成：{e}")),
        }
        db.execute("UPDATE resegment_cleanup SET done=1 WHERE recording_id=?1 AND path=?2", params![id,path]).map_err(err)?;
    }
    db.execute("DELETE FROM extraction_files WHERE recording_id=?1",[id]).map_err(err)?;
    Ok(())
}

/// Caller serializes this operation with extraction and source removal.
#[allow(dead_code)]
pub fn begin(db: &Connection, id: &str, seconds: f64) -> Result<()> {
    if !seconds.is_finite() || seconds <= 0.0 { return Err("请输入大于0的停顿秒数".into()); }
    let (path, fingerprint, status):(String,String,String)=db.query_row(
        "SELECT r.path,t.fingerprint,q.status FROM recordings r JOIN local_transcriptions t ON t.recording_id=r.id JOIN processing_queue q ON q.recording_id=r.id WHERE r.id=?1 AND t.phase='completed' AND t.body IS NOT NULL",
        [id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"请先完成这条录音的处理".to_string())?;
    if status != "completed" { return Err("任务当前不可重新分段".into()); }
    if crate::transcription::fingerprint(Path::new(&path))? != fingerprint { return Err("原录音已变化，请恢复原文件".into()); }
    prepare_inner(db,id,Some(seconds))?;
    resume(db,id)
}

#[allow(dead_code)]
pub fn resume(db: &Connection, id: &str) -> Result<()> {
    let cleaning:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM processing_queue WHERE recording_id=?1 AND stage='cleaning' AND status IN ('failed','interrupted'))",[id],|r|r.get(0)).map_err(err)?;
    if !cleaning {return Err("任务当前不需要清理".into());}
    clean(db,id)?;
    crate::queue::retry(db,id)
}

pub fn generation(db:&Connection,id:&str)->Result<Option<String>> {
    use rusqlite::OptionalExtension;
    db.query_row("SELECT generation FROM resegment_runs WHERE recording_id=?1",[id],|r|r.get(0)).optional().map_err(err)
}

fn registered_other_paths(db:&Connection,id:&str)->Result<Vec<String>> {
    let mut q=db.prepare("SELECT path FROM extraction_files WHERE recording_id<>?1").map_err(err)?;
    let rows=q.query_map([id],|r|r.get(0)).map_err(err)?;
    rows.collect::<std::result::Result<_,_>>().map_err(err)
}

/// Called while holding source_operation, before creating any output file.
pub fn register_extraction(db:&Connection,clip_id:&str,source:&Path,paths:&[&Path])->Result<()> {
    let retired:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM retired_clips WHERE id=?1)",[clip_id],|r|r.get(0)).map_err(err)?;
    if retired {return Err("片段已清空，无法继续提取".into());}
    let library=read_v1_library(db)?.ok_or("片段尚未保存，请稍后重试")?;
    let item=library["items"].as_array().and_then(|items|items.iter().find(|i|i["id"]==clip_id)).ok_or("片段不存在，无法提取")?;
    let id=item["sourceId"].as_str().ok_or("缺少录音标识")?;
    let original:String=db.query_row("SELECT path FROM recordings WHERE id=?1",[id],|r|r.get(0)).map_err(err)?;
    if fs::canonicalize(original).map_err(err)? != source {return Err("提取来源与片段不一致".into());}
    let tx=db.unchecked_transaction().map_err(err)?;
    for path in paths {tx.execute("INSERT INTO extraction_files(path,recording_id,clip_id) VALUES(?1,?2,?3)",params![path.to_string_lossy(),id,clip_id]).map_err(err)?;}
    tx.commit().map_err(err)
}

#[tauri::command]
pub async fn resegment_recording(app:tauri::AppHandle,id:String,seconds:f64)->Result<()> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let store=app.state::<crate::Store>();
        let _operation=store.source_operation.lock().map_err(err)?;
        let db=store.connection.lock().map_err(err)?;
        begin(&db,&id,seconds)
    }).await.map_err(err)?
}

#[tauri::command]
pub fn retired_clip_ids(state:tauri::State<crate::Store>)->Result<Vec<String>> {
    let db=state.connection.lock().map_err(err)?;
    let mut q=db.prepare("SELECT id FROM retired_clips").map_err(err)?;
    let rows=q.query_map([],|r|r.get(0)).map_err(err)?;
    rows.collect::<std::result::Result<_,_>>().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registered_outputs_are_cleaned_before_frontend_saves_and_late_exports_are_rejected() {
        let root=std::env::temp_dir().join(format!("once-extraction-cleanup-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let original=root.join("source.wav");fs::write(&original,b"original").unwrap();
        let source=fs::canonicalize(&original).unwrap();
        let temporary=root.join("output.partial.wav");let output=root.join("output.wav");
        let db=Connection::open_in_memory().unwrap();crate::initialize(&db).unwrap();
        db.execute("INSERT INTO recordings VALUES('a',?1,'source',0,8)",[source.to_str().unwrap()]).unwrap();
        crate::write_v1_library(&db,&serde_json::json!({"version":1,"items":[{"id":"clip-a","sourceId":"a"}]})).unwrap();
        register_extraction(&db,"clip-a",&source,&[&temporary,&output]).unwrap();
        // Simulate output publication followed by an interrupted frontend save.
        fs::write(&output,b"export").unwrap();
        prepare(&db,"a").unwrap();clean(&db,"a").unwrap();
        assert!(!output.exists());assert!(original.exists());
        assert!(register_extraction(&db,"clip-a",&source,&[&output]).is_err());
        assert!(!output.exists());
        fs::remove_file(original).unwrap();fs::remove_dir(root).unwrap();
    }
    #[test]
    fn partial_cleanup_resumes_and_stale_saves_cannot_restore() {
        let root = std::env::temp_dir().join(format!("once-cleanup-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let a=root.join("a.wav");let b=root.join("b.wav");
        fs::write(&a,b"clip").unwrap();fs::write(&b,b"clip").unwrap();
        let database=root.join("test.sqlite3");
        let db=Connection::open(&database).unwrap();crate::initialize(&db).unwrap();
        let mut stale=serde_json::json!({"version":1,"items":[{"id":"old-a","sourceId":"a","clipPath":a},{"id":"old-b","sourceId":"a","clipPath":b}]});
        crate::write_v1_library(&db,&stale).unwrap();prepare(&db,"a").unwrap();
        fs::remove_file(&b).unwrap();fs::create_dir(&b).unwrap();
        assert!(clean(&db,"a").is_err());assert!(!a.exists());assert!(b.is_dir());
        drop(db);let db=Connection::open(&database).unwrap();crate::initialize(&db).unwrap();
        crate::queue::preserve_new_items(&db,&mut stale).unwrap();assert!(stale["items"].as_array().unwrap().is_empty());
        fs::remove_dir(&b).unwrap();fs::write(&b,b"clip").unwrap();clean(&db,"a").unwrap();clean(&db,"a").unwrap();
        assert!(!b.exists());drop(db);fs::remove_file(database).unwrap();fs::remove_dir(root).unwrap();
    }
    #[test]
    fn refuses_source_and_shared_files_without_changing_library() {
        let path=std::env::temp_dir().join(format!("once-protected-{}",uuid::Uuid::new_v4()));fs::write(&path,b"original").unwrap();
        let db=Connection::open_in_memory().unwrap();crate::initialize(&db).unwrap();
        db.execute("INSERT INTO recordings VALUES('a',?1,'source',0,8)",[path.to_str().unwrap()]).unwrap();
        let library=serde_json::json!({"version":1,"items":[{"id":"old","sourceId":"a","clipPath":path}]});
        crate::write_v1_library(&db,&library).unwrap();assert!(prepare(&db,"a").is_err());
        assert_eq!(read_v1_library(&db).unwrap().unwrap(),library);assert!(path.exists());
        db.execute("UPDATE recordings SET path='/missing-original'",[]).unwrap();
        let shared=serde_json::json!({"version":1,"items":[{"id":"old","sourceId":"a","clipPath":path},{"id":"keep","sourceId":"b","clipPath":path}]});
        crate::write_v1_library(&db,&shared).unwrap();assert!(prepare(&db,"a").is_err());
        assert_eq!(read_v1_library(&db).unwrap().unwrap(),shared);assert!(path.exists());fs::remove_file(path).unwrap();
    }
}

/// Explicit full-result cleanup. Retains recording registration for the next scan.
pub fn clear_results(db: &Connection, id: &str, root: &Path) -> Result<()> {
    uuid::Uuid::parse_str(id).map_err(err)?;
    let status:String=db.query_row("SELECT status FROM processing_queue WHERE recording_id=?1",[id],|r|r.get(0)).map_err(err)?;
    if status=="running" || status=="waiting" {return Err("正在处理的录音不能清除".into());}
    let source:String=db.query_row("SELECT path FROM recordings WHERE id=?1",[id],|r|r.get(0)).map_err(err)?;
    let work=root.join("transcription-work").join(id);
    fn files(path:&Path, out:&mut Vec<String>)->Result<()> {
        let m=match fs::symlink_metadata(path) {Ok(m)=>m,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(()),Err(e)=>return Err(err(e))};
        if m.file_type().is_symlink(){return Err("缓存路径异常，已停止清理".into());}
        if m.is_dir(){for entry in fs::read_dir(path).map_err(err)? {files(&entry.map_err(err)?.path(),out)?;}}
        else {out.push(path.to_string_lossy().into_owned());} Ok(())
    }
    let mut cached=Vec::new();files(&work,&mut cached)?;
    let checkpoints=root.join("queue-checkpoints");
    if checkpoints.is_dir(){for entry in fs::read_dir(&checkpoints).map_err(err)? {let p=entry.map_err(err)?.path();let name=p.file_name().unwrap().to_string_lossy();if name==format!("{id}.json") || (name.starts_with(&format!("{id}-")) && name.ends_with(".json")){cached.push(p.to_string_lossy().into_owned());}}}
    let mut protected=vec![source];
    {let mut q=db.prepare("SELECT path FROM recordings").map_err(err)?;for p in q.query_map([],|r|r.get::<_,String>(0)).map_err(err)?{protected.push(p.map_err(err)?);}}
    protected.extend(registered_other_paths(db,id)?);
    for p in &cached {validate_target(Path::new(p),&protected)?;}
    prepare(db,id)?;
    clean(db,id)?;
    for p in cached {fs::remove_file(p).map_err(err)?;}
    let tx=db.unchecked_transaction().map_err(err)?;
    for table in ["processing_timing","processing_progress","local_transcriptions","processing_task_batches","processing_queue","resegment_cleanup"] {tx.execute(&format!("DELETE FROM {table} WHERE recording_id=?1"),[id]).map_err(err)?;}
    // New IDs prevent stale frontend saves from resurrecting cleared clips.
    tx.execute("INSERT INTO resegment_runs VALUES(?1,?2) ON CONFLICT(recording_id) DO UPDATE SET generation=excluded.generation",params![id,format!("fresh-{}",uuid::Uuid::new_v4())]).map_err(err)?;
    tx.commit().map_err(err)
}

#[tauri::command]
pub async fn clear_processing_results(app:tauri::AppHandle,id:String)->Result<()> {
    use tauri::Manager;
    use std::sync::atomic::Ordering;
    tauri::async_runtime::spawn_blocking(move || {
        let worker=app.state::<crate::transcription::Worker>();
        if worker.0.swap(true,Ordering::SeqCst){return Err("录音正在处理中，请完成后再清除".into());}
        struct Release<'a>(&'a crate::transcription::Worker);
        impl Drop for Release<'_>{fn drop(&mut self){self.0.0.store(false,Ordering::SeqCst);}}
        let _release=Release(&worker);
        let state=app.state::<crate::Store>();
        let _operation=state.source_operation.lock().map_err(err)?;
        let db=state.connection.lock().map_err(err)?;
        clear_results(&db,&id,&app.path().app_data_dir().map_err(err)?)
    }).await.map_err(err)?
}

#[cfg(test)]
mod clear_tests {
    use super::*;
    #[test]
    fn clears_results_but_keeps_source_and_allows_fresh_queue() {
        let root=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());fs::create_dir_all(&root).unwrap();
        let source=root.join("original.wav");fs::write(&source,b"original backup fixture").unwrap();
        let clip=root.join("clip.wav");fs::write(&clip,b"extracted fixture").unwrap();
        let id=uuid::Uuid::new_v4().to_string();let db=Connection::open_in_memory().unwrap();crate::initialize(&db).unwrap();crate::transcription::initialize(&db).unwrap();
        db.execute("INSERT INTO recordings VALUES(?1,?2,'test',0,23)",params![id,source.to_str().unwrap()]).unwrap();
        db.execute("INSERT INTO processing_queue(recording_id,status,stage) VALUES(?1,'running','transcribing')",[&id]).unwrap();
        let work=root.join("transcription-work").join(&id);fs::create_dir_all(&work).unwrap();fs::write(work.join("result.json"),b"cached").unwrap();
        crate::write_v1_library(&db,&serde_json::json!({"version":1,"items":[{"id":"old","sourceId":id,"clipPath":clip,"saved":true,"listens":4},{"id":"other","sourceId":"other"}]})).unwrap();
        assert!(clear_results(&db,&id,&root).is_err());assert!(clip.exists());
        db.execute("UPDATE processing_queue SET status='completed'",[]).unwrap();
        db.execute("INSERT INTO local_transcriptions(recording_id,phase,body) VALUES(?1,'completed','[]')",[&id]).unwrap();
        clear_results(&db,&id,&root).unwrap();
        assert_eq!(fs::read(&source).unwrap(),b"original backup fixture");assert!(!clip.exists());assert!(!work.join("result.json").exists());
        assert_eq!(read_v1_library(&db).unwrap().unwrap()["items"].as_array().unwrap().len(),1);
        assert_eq!(db.query_row("SELECT count(*) FROM local_transcriptions",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(db.query_row("SELECT count(*) FROM processing_queue",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert!(generation(&db,&id).unwrap().is_some());
        db.execute("INSERT INTO processing_queue(recording_id,status,stage) VALUES(?1,'waiting','preparing')",[&id]).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
