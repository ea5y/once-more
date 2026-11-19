//! Signed updates; recording/model files are never part of the replacement bundle.
use crate::{err, queue, transcription, Result, Store};
use serde::Serialize;
use std::{fs, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates { installing: AtomicBool, operation: AtomicBool, pending: Mutex<Option<Pending>> }
struct Pending { update: Update, bytes: Option<Vec<u8>> }
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
impl Updates {
    pub fn is_installing(&self)->bool { self.installing.load(Ordering::SeqCst) }
    fn begin(&self) -> Result<Operation<'_>> {
        self.operation.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).map_err(|_| "更新操作进行中，请稍候".to_string())?;
        Ok(Operation(&self.operation))
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Progress { downloaded: u64, total: Option<u64> }

#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> Result<Option<String>> {
    let state=app.state::<Updates>(); let _operation=state.begin()?;
    // Do not discard a verified download during a background check.
    if let Some(p)=state.pending.lock().map_err(err)?.as_ref() { return Ok(Some(p.update.version.clone())); }
    let update=app.updater_builder().timeout(Duration::from_secs(20)).build().map_err(err)?.check().await.map_err(err)?;
    let version=update.as_ref().map(|u|u.version.clone());
    *state.pending.lock().map_err(err)?=update.map(|mut update| { update.timeout=Some(Duration::from_secs(1800)); Pending {update,bytes:None} });
    Ok(version)
}
#[tauri::command]
pub async fn download_app_update(app: tauri::AppHandle) -> Result<()> {
    let state=app.state::<Updates>(); let _operation=state.begin()?;
    let update={let pending=state.pending.lock().map_err(err)?;let p=pending.as_ref().ok_or("未发现可用更新")?;if p.bytes.is_some(){return Ok(());}p.update.clone()};
    let mut downloaded=0u64; let mut last_event=std::time::Instant::now()-Duration::from_secs(1);
    let bytes=update.download(|chunk,total| {downloaded+=chunk as u64;if last_event.elapsed()>=Duration::from_millis(200) {let _=app.emit("app-update-progress",Progress{downloaded,total});last_event=std::time::Instant::now();}},||{}).await.map_err(err)?;
    state.pending.lock().map_err(err)?.as_mut().ok_or("更新记录已失效")?.bytes=Some(bytes);
    Ok(())
}
fn busy(app:&tauri::AppHandle) -> Result<bool> {
    let store=app.state::<Store>();
    if store.scanning.load(Ordering::SeqCst) || app.state::<queue::Runner>().is_active() || app.state::<transcription::Worker>().0.load(Ordering::SeqCst) {return Ok(true);}
    if app.state::<std::sync::Arc<crate::model::ModelManager>>().is_busy() {return Ok(true);}
    let db=store.connection.lock().map_err(err)?;
    db.query_row("SELECT EXISTS(SELECT 1 FROM processing_queue WHERE status IN ('waiting','running'))",[],|r|r.get(0)).map_err(err)
}
#[tauri::command]
pub fn app_update_busy(app:tauri::AppHandle)->Result<bool> {
    if app.state::<Store>().source_operation.try_lock().is_err(){return Ok(true);}
    busy(&app)
}
fn backup(db:&rusqlite::Connection,path:&std::path::Path)->Result<()> {
    db.execute("VACUUM INTO ?1",[path.to_string_lossy().as_ref()]).map_err(err)?;
    let copy=rusqlite::Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    let result:String=copy.query_row("PRAGMA quick_check",[],|r|r.get(0)).map_err(err)?;
    if result!="ok" {return Err("更新前备份检查失败，未安装更新".into());} Ok(())
}
#[tauri::command]
pub async fn install_app_update(app:tauri::AppHandle)->Result<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<Updates>();let _operation=state.begin()?;
        let store=app.state::<Store>();
        let Ok(_source)=store.source_operation.try_lock() else {return Ok(false);};
        if busy(&app)? {return Ok(false);}
        let mut pending=state.pending.lock().map_err(err)?;
        let p=pending.as_mut().ok_or("未发现可用更新")?;
        let bytes=p.bytes.as_ref().ok_or("更新尚未下载完成")?;
        let directory=app.path().app_data_dir().map_err(err)?.join("update-backups");
        fs::create_dir_all(&directory).map_err(err)?;
        let db=store.connection.lock().map_err(err)?;
        backup(&db,&directory.join(format!("before-update-{}.sqlite3",uuid::Uuid::new_v4())))?;
        state.installing.store(true,Ordering::SeqCst);
        let installing=Operation(&state.installing);
        p.update.install(bytes).map_err(err)?;
        drop(installing);
        drop(db);
        app.request_restart();
        Ok(true)
    }).await.map_err(err)?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn backup_preserves_committed_data_and_does_not_overwrite() {
        let db=rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE settings(k TEXT); INSERT INTO settings VALUES('keep');").unwrap();
        let path=std::env::temp_dir().join(format!("once-more-update-{}.sqlite3",uuid::Uuid::new_v4()));
        backup(&db,&path).unwrap();
        assert!(backup(&db,&path).is_err());
        let copy=rusqlite::Connection::open(&path).unwrap();
        assert_eq!(copy.query_row("SELECT k FROM settings",[],|r|r.get::<_,String>(0)).unwrap(),"keep");
        drop(copy);fs::remove_file(path).unwrap();
    }
}
