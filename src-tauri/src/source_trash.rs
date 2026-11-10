use crate::{audio, err, read_v1_library, source_check, Result, Store};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{path::Path, sync::atomic::{AtomicBool, Ordering}};
use tauri::Manager;

pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS source_trash (source_id TEXT PRIMARY KEY, path TEXT NOT NULL, phase TEXT NOT NULL);").map_err(err)
}

// A durable intent precedes the OS operation. Stale frontend saves cannot revive a removed source.
pub fn overlay(db: &Connection, library: &mut Value) -> Result<()> {
    let mut query = db.prepare("SELECT source_id,path,phase FROM source_trash").map_err(err)?;
    let rows = query.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(err)?;
    for row in rows {
        let (id,path,phase) = row.map_err(err)?;
        if phase != "prepared" || !Path::new(&path).exists() {
            if let Some(items) = library["items"].as_array_mut() {
                for item in items.iter_mut().filter(|i| i["sourceId"] == id) {
                    item["sourceAvailable"] = false.into();
                    item["sourceTrashPending"] = (phase != "done").into();
                    item["sourceTrashed"] = (phase != "prepared").into();
                    item["sourceTrashUncertain"] = (phase == "prepared").into();
                }
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Outcome { pub restored: bool, pub moved: bool, pub pending: bool, pub uncertain: bool, pub error: Option<String> }
fn finish(db: &Connection, id: &str) -> Result<()> {
    let mut library = read_v1_library(db)?.ok_or("片段记录不存在")?;
    if let Some(items) = library["items"].as_array_mut() {
        for item in items.iter_mut().filter(|i| i["sourceId"] == id) {
            item["sourceAvailable"] = false.into();
            item["sourceTrashPending"] = false.into();
            item["sourceTrashed"] = true.into();
            item["sourceTrashUncertain"] = false.into();
        }
    }
    let tx = db.unchecked_transaction().map_err(err)?;
    tx.execute("UPDATE v1_library SET body=?1 WHERE id=1", [library.to_string()]).map_err(err)?;
    tx.execute("UPDATE source_trash SET phase='done' WHERE source_id=?1", [id]).map_err(err)?;
    tx.commit().map_err(err)
}
fn complete(db: &Connection, id: &str) -> Outcome {
    match finish(db,id) {
        Ok(()) => Outcome { restored:false, moved:true,pending:false,uncertain:false,error:None },
        Err(e) => Outcome { restored:false, moved:true,pending:true,uncertain:false,error:Some(e) },
    }
}

fn perform(db: &Connection, id: &str, tools: &audio::Tools, mover: impl FnOnce(&Path)->Result<()>) -> Result<Outcome> {
    let previous: Option<(String,String)> = db.query_row("SELECT path,phase FROM source_trash WHERE source_id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
    if let Some((path,phase)) = previous {
        if phase == "moved" || phase == "done" { return Ok(complete(db,id)); }
        if !Path::new(&path).exists() {
            // Crash between the OS move and its receipt: do not guess success or move a replacement file.
            return Ok(Outcome { restored:false, moved:false,pending:true,uncertain:true,error:Some("上次操作被中断，原录音已不在原位置。请先在系统废纸篓确认并恢复原文件，再重新检查。".into()) });
        }
        // An interrupted operation with the source present is reset, never retried implicitly.
        db.execute("DELETE FROM source_trash WHERE source_id=?1", [id]).map_err(err)?;
        return Ok(Outcome { restored:true, moved:false,pending:false,uncertain:false,error:None });
    }
    let library = read_v1_library(db)?.ok_or("没有已保存的片段")?;
    let path: String = db.query_row("SELECT path FROM recordings WHERE id=?1", [id], |r| r.get(0)).map_err(err)?;
    let source = Path::new(&path);
    if std::fs::symlink_metadata(source).map_err(err)?.file_type().is_symlink() { return Err("原录音是符号链接，请使用实际文件".into()); }
    let check = source_check::inspect(&library,id,source,false,tools);
    if !check.ready { return Err(check.errors.join("；")); }
    db.execute("INSERT INTO source_trash(source_id,path,phase) VALUES(?1,?2,'prepared') ON CONFLICT(source_id) DO UPDATE SET path=excluded.path,phase='prepared'", [id,&path]).map_err(err)?;
    if let Err(e) = mover(source) {
        if source.exists() {
            db.execute("DELETE FROM source_trash WHERE source_id=?1", [id]).map_err(err)?;
            return Err(format!("原录音仍在原位置：{e}"));
        }
        return Ok(Outcome { restored:false, moved:false,pending:true,uncertain:true,error:Some(format!("原录音已不在原位置，请检查系统废纸篓：{e}")) });
    }
    if let Err(e) = db.execute("UPDATE source_trash SET phase='moved' WHERE source_id=?1", [id]) {
        return Ok(Outcome { restored:false, moved:true,pending:true,uncertain:false,error:Some(err(e)) });
    }
    Ok(complete(db,id))
}

#[cfg(target_os="macos")]
fn system_trash(path: &Path) -> Result<()> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let path = path.to_str().ok_or("文件路径无法识别")?;
    NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&NSURL::fileURLWithPath(&NSString::from_str(path)),None).map_err(err)
}
#[cfg(not(target_os="macos"))]
fn system_trash(_: &Path) -> Result<()> { Err("当前仅支持macOS系统废纸篓".into()) }

struct Reservation<'a>(&'a AtomicBool);
impl Drop for Reservation<'_> { fn drop(&mut self) { self.0.store(false,Ordering::SeqCst); } }
fn reserve(flag: &AtomicBool) -> Result<Reservation<'_>> {
    flag.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).map_err(|_| "录音仍在处理中，请稍后重试".to_string())?;
    Ok(Reservation(flag))
}
#[tauri::command]
pub async fn trash_source(source_id: String, app: tauri::AppHandle) -> Result<Outcome> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Store>();
        let worker = app.state::<crate::transcription::Worker>();
        let _scan = reserve(&state.scanning)?;
        let _transcription = reserve(&worker.0)?;
        let _operation = state.source_operation.lock().map_err(err)?;
        let db = state.connection.lock().map_err(err)?;
        let tools = audio::Tools::discover(app.path().resource_dir().ok().as_deref())?;
        perform(&db,&source_id,&tools,system_trash)
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (Connection,std::path::PathBuf,audio::Tools) {
        let root=std::env::temp_dir().join(format!("once-trash-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        // One second of PCM silence, independent source and clip files.
        let mut wav=Vec::new();
        wav.extend(b"RIFF");wav.extend(32036u32.to_le_bytes());wav.extend(b"WAVEfmt ");wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());wav.extend(1u16.to_le_bytes());wav.extend(16000u32.to_le_bytes());wav.extend(32000u32.to_le_bytes());
        wav.extend(2u16.to_le_bytes());wav.extend(16u16.to_le_bytes());wav.extend(b"data");wav.extend(32000u32.to_le_bytes());wav.resize(32044,0);
        let source=root.join("source.wav");let clip=root.join("clip.wav");
        std::fs::write(&source,&wav).unwrap();std::fs::write(&clip,&wav).unwrap();
        let db=Connection::open(root.join("test.sqlite3")).unwrap();crate::initialize(&db).unwrap();
        db.execute("INSERT INTO recordings VALUES('test',?1,'source.wav',0,32044)",[source.to_str().unwrap()]).unwrap();
        crate::write_v1_library(&db,&json!({"version":1,"items":[{"sourceId":"test","sourcePath":source,"sourceAvailable":true,"clipPath":clip,"start":0.0,"duration":1.0,"extraction":"done","extractedRange":{"start":0.0,"end":1.0}}]})).unwrap();
        (db,root,audio::Tools::discover(None).unwrap())
    }
    #[test]
    fn failed_move_keeps_source_and_can_retry() {
        let (db,root,tools)=fixture();
        assert!(perform(&db,"test",&tools,|_|Err("permission denied".into())).is_err());
        assert!(root.join("source.wav").exists());
        let result=perform(&db,"test",&tools,|p|std::fs::rename(p,root.join("mock-trash.wav")).map_err(err)).unwrap();
        assert!(result.moved && !result.pending);
        assert_eq!(read_v1_library(&db).unwrap().unwrap()["items"][0]["sourceAvailable"],false);
        assert!(perform(&db,"test",&tools,|_|panic!("must not move twice")).unwrap().moved);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_save_preserves_receipt_and_retries_only_save() {
        let (db,root,tools)=fixture();
        db.execute_batch("CREATE TRIGGER fail_save BEFORE UPDATE ON v1_library BEGIN SELECT RAISE(FAIL,'disk failure'); END;").unwrap();
        let result=perform(&db,"test",&tools,|p|std::fs::rename(p,root.join("mock-trash.wav")).map_err(err)).unwrap();
        assert!(result.moved && result.pending);
        let mut stale=read_v1_library(&db).unwrap().unwrap();overlay(&db,&mut stale).unwrap();
        assert_eq!(stale["items"][0]["sourceAvailable"],false);
        assert_eq!(stale["items"][0]["sourceTrashPending"],true);
        drop(db);
        let db=Connection::open(root.join("test.sqlite3")).unwrap();
        let mut reopened=read_v1_library(&db).unwrap().unwrap();overlay(&db,&mut reopened).unwrap();
        assert_eq!(reopened["items"][0]["sourceTrashPending"],true);
        db.execute_batch("DROP TRIGGER fail_save;").unwrap();
        assert!(!perform(&db,"test",&tools,|_|panic!("must only save")).unwrap().pending);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_move_never_blindly_repeats() {
        let (db,root,tools)=fixture();
        db.execute("INSERT INTO source_trash VALUES('test',?1,'prepared')",[root.join("source.wav").to_str().unwrap()]).unwrap();
        std::fs::rename(root.join("source.wav"),root.join("mock-trash.wav")).unwrap();
        let result=perform(&db,"test",&tools,|_|panic!("uncertain outcome must not move")).unwrap();
        assert!(result.pending && result.uncertain && !result.moved);
        std::fs::rename(root.join("mock-trash.wav"),root.join("source.wav")).unwrap();
        assert!(perform(&db,"test",&tools,|_|panic!("restored file needs fresh confirmation")).unwrap().restored);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn incomplete_clip_never_calls_system_move() {
        let (db,root,tools)=fixture();std::fs::write(root.join("clip.wav"),b"broken").unwrap();
        assert!(perform(&db,"test",&tools,|_|panic!("invalid clip must not move")).is_err());
        assert!(root.join("source.wav").exists());std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "explicit macOS smoke test: moves only a generated disposable file to system Trash"]
    fn system_trash_disposable_file() {
        let file=std::env::temp_dir().join(format!("once-more-disposable-{}.txt",uuid::Uuid::new_v4()));
        std::fs::write(&file,b"Once More disposable trash API verification").unwrap();
        system_trash(&file).unwrap();assert!(!file.exists());
    }
}
