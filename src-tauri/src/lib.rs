use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use tauri::Manager;
use uuid::Uuid;
use walkdir::WalkDir;

type Result<T> = std::result::Result<T, String>;
mod audio;
mod media;
mod model;
mod simplified;
mod transcription;
mod pause;
mod source_check;
mod source_trash;
mod queue;
mod resegment;
mod processes;
mod exit_guard;
pub use processes::supervisor_entry;
struct Store { connection: Mutex<Connection>, scanning: AtomicBool, waveform_lock: Mutex<()>, source_operation: Mutex<()> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recording { id: String, path: String, name: String, modified: u64, size: u64 }

#[derive(Serialize, Deserialize)]
struct Transcript { speaker: String, text: String }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Memory {
    id: String, recording_id: String, title: String, date: String, time: String,
    start: f64, end: f64, kind: String, saved: bool, recommended: bool,
    listens: u32, transcript: Vec<Transcript>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot { source: Option<String>, output: Option<String>, last_scan: Option<String>, recordings: Vec<Recording>, memories: Vec<Memory> }

fn err(e: impl std::fmt::Display) -> String { e.to_string() }
fn setting(db: &Connection, key: &str) -> Result<Option<String>> {
    db.query_row("SELECT value FROM settings WHERE key=?1", [key], |row| row.get(0)).optional().map_err(err)
}

fn initialize(db: &Connection) -> Result<()> {
    source_trash::initialize(db)?;
    queue::initialize(db)?;
    resegment::initialize(db)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, modified INTEGER NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clips (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id), path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS waveforms (recording_id TEXT PRIMARY KEY REFERENCES recordings(id), fingerprint TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v1_waveforms (path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scan_history (id TEXT PRIMARY KEY, source TEXT, started INTEGER NOT NULL, status TEXT NOT NULL, count INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS v1_library (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      UPDATE scan_history SET status='failed',error='上次扫描被中断，请重试' WHERE status='running';
      PRAGMA user_version=2;").map_err(err)
}

#[tauri::command]
fn load_snapshot(app: tauri::AppHandle, state: tauri::State<Store>) -> Result<Snapshot> {
    let db = state.connection.lock().map_err(err)?;
    let mut statement = db.prepare("SELECT id,path,name,modified,size FROM recordings ORDER BY modified DESC").map_err(err)?;
    let recordings = statement.query_map([], |r| Ok(Recording { id: r.get(0)?, path: r.get(1)?, name: r.get(2)?, modified: r.get(3)?, size: r.get(4)? })).map_err(err)?.collect::<std::result::Result<Vec<_>, _>>().map_err(err)?;
    for recording in &recordings { app.asset_protocol_scope().allow_file(&recording.path).map_err(err)?; }
    let mut statement = db.prepare("SELECT body FROM memories").map_err(err)?;
    let rows = statement.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
    let mut memories = Vec::new();
    for row in rows { memories.push(serde_json::from_str(&row.map_err(err)?).map_err(err)?); }
    Ok(Snapshot { source: setting(&db, "source")?, output: setting(&db, "output")?, last_scan: setting(&db, "last_scan")?, recordings, memories })
}

#[derive(Serialize)]
struct FolderConfig { source: FolderStatus, output: FolderStatus }
#[derive(Serialize)]
struct FolderStatus { path: Option<String>, error: Option<String> }
fn folder_status(path: Option<String>) -> FolderStatus {
    let error = path.as_ref().and_then(|p| fs::read_dir(p).err().map(|_| "文件夹不存在或无法访问，请重新选择".to_string()));
    FolderStatus { path, error }
}
#[tauri::command]
fn get_v1_folders(state: tauri::State<Store>) -> Result<FolderConfig> {
    let db = state.connection.lock().map_err(err)?;
    Ok(FolderConfig { source: folder_status(setting(&db, "source")?), output: folder_status(setting(&db, "output")?) })
}

#[tauri::command]
fn set_folder(kind: String, path: String, state: tauri::State<Store>) -> Result<()> {
    if kind != "source" && kind != "output" { return Err("无效的文件夹类型".into()); }
    let folder = fs::canonicalize(&path).map_err(err)?;
    if !folder.is_dir() { return Err("请选择文件夹".into()); }
    fs::read_dir(&folder).map_err(|_| "文件夹无法访问，请选择其他位置".to_string())?;
    let db = state.connection.lock().map_err(err)?;
    let other = if kind == "source" { "output" } else { "source" };
    if let Some(other) = setting(&db, other)? {
        let other = Path::new(&other);
        if folder.starts_with(other) || other.starts_with(&folder) {
            return Err("录音来源与输出位置请选择互不包含的两个文件夹，避免重复扫描导出的片段。".into());
        }
    }
    db.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![kind,folder.to_string_lossy()]).map_err(err)?;
    Ok(())
}

fn discover_recordings(source: &str) -> Result<Vec<Recording>> {
    if !Path::new(source).is_dir() { return Err("录音来源文件夹不存在或无法访问，请重新选择".into()); }
        let mut found = Vec::new();
        for entry in WalkDir::new(&source).follow_links(false) {
            let entry = entry.map_err(|e| format!("无法读取部分文件：{e}"))?;
            if !entry.file_type().is_file() { continue; }
            let extension = entry.path().extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
            if !["wav", "mp3", "m4a", "aac", "flac", "ogg", "aiff", "aif"].contains(&extension.as_str()) { continue; }
            let meta = entry.metadata().map_err(err)?;
            let path = fs::canonicalize(entry.path()).map_err(err)?;
            found.push(Recording { id: Uuid::new_v4().to_string(), path: path.to_string_lossy().into_owned(), name: entry.file_name().to_string_lossy().into_owned(), modified: meta.modified().unwrap_or(UNIX_EPOCH).duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(), size: meta.len() });
        }
    Ok(found)
}

#[tauri::command]
fn get_v1_scan_time(state: tauri::State<Store>) -> Result<Option<String>> {
    let db = state.connection.lock().map_err(err)?;
    setting(&db, "last_scan")
}

#[derive(Serialize)]
struct ScanRecord { id: String, source: Option<String>, started: i64, status: String, count: Option<usize>, error: Option<String> }
fn scan_history(db: &Connection) -> Result<Vec<ScanRecord>> {
    let mut statement = db.prepare("SELECT id,source,started,status,count,error FROM scan_history ORDER BY started DESC,rowid DESC LIMIT 50").map_err(err)?;
    let rows = statement.query_map([], |r| Ok(ScanRecord { id:r.get(0)?, source:r.get(1)?, started:r.get(2)?, status:r.get(3)?, count:r.get(4)?, error:r.get(5)? })).map_err(err)?;
    rows.collect::<std::result::Result<Vec<_>,_>>().map_err(err)
}
#[tauri::command]
fn get_scan_history(state: tauri::State<Store>) -> Result<Vec<ScanRecord>> {
    let db = state.connection.lock().map_err(err)?;
    scan_history(&db)
}
#[tauri::command]
async fn scan_recordings(app: tauri::AppHandle, retry_id: Option<String>) -> Result<usize> {
    let state = app.state::<Store>();
    if state.scanning.swap(true, Ordering::SeqCst) { return Err("扫描正在进行中".into()); }
    let task_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<usize> {
        let state = task_app.state::<Store>();
        let id = Uuid::new_v4().to_string();
        let started = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_secs();
        let source = {
            let db = state.connection.lock().map_err(err)?;
            let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM processing_queue WHERE status IN ('waiting','running','interrupted'))",[],|r|r.get(0)).map_err(err)?;
            if pending || task_app.state::<queue::Runner>().is_active() {return Err("本轮处理尚未完成，请先继续处理".into());}
            let pause=setting(&db,"pause_seconds")?.unwrap_or_else(||"6".into());
            db.execute("INSERT INTO settings(key,value) VALUES('scan_pause_snapshot',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[pause]).map_err(err)?;
            let source: Option<String> = if let Some(retry) = retry_id {
                db.query_row("SELECT source FROM scan_history WHERE id=?1 AND status='failed'", [retry], |r| r.get(0)).map_err(|_| "失败任务不存在或不可重试".to_string())?
            } else { setting(&db,"source")? };
            db.execute("INSERT INTO scan_history(id,source,started,status) VALUES(?1,?2,?3,'running')", params![id,source,started]).map_err(err)?;
            source
        };
        let outcome = (|| -> Result<usize> {
            let source = source.as_deref().ok_or("请先选择录音来源")?;
            let found = discover_recordings(source)?;
            let count = found.len();
            // Read metadata once per changed file, outside the database lock.
            let tools = audio::Tools::discover(task_app.path().resource_dir().ok().as_deref()).ok();
            let mut durations = Vec::new();
            for recording in &found {
                let cached: bool = { let db=state.connection.lock().map_err(err)?; db.query_row("SELECT EXISTS(SELECT 1 FROM recording_audio_metadata WHERE path=?1 AND modified=?2 AND size=?3)",params![recording.path,recording.modified,recording.size],|r|r.get(0)).map_err(err)? };
                if !cached { if let Some(duration)=tools.as_ref().and_then(|t|t.duration(Path::new(&recording.path)).ok()) {durations.push((recording.path.clone(),recording.modified,recording.size,duration));} }
            }
            let mut db = state.connection.lock().map_err(err)?;
            let tx = db.transaction().map_err(err)?;
            for recording in found {
                task_app.asset_protocol_scope().allow_file(&recording.path).map_err(err)?;
                tx.execute("INSERT INTO recordings(id,path,name,modified,size) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(path) DO UPDATE SET name=excluded.name,modified=excluded.modified,size=excluded.size", params![recording.id,recording.path,recording.name,recording.modified,recording.size]).map_err(err)?;
            }
            for (path,modified,size,duration) in durations {tx.execute("INSERT INTO recording_audio_metadata(path,modified,size,duration) VALUES(?1,?2,?3,?4) ON CONFLICT(path) DO UPDATE SET modified=excluded.modified,size=excluded.size,duration=excluded.duration",params![path,modified,size,duration]).map_err(err)?;}
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_secs().to_string();
            tx.execute("INSERT INTO settings(key,value) VALUES('last_scan',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [stamp]).map_err(err)?;
            tx.execute("UPDATE scan_history SET status='succeeded',count=?1 WHERE id=?2", params![count,id]).map_err(err)?;
            tx.commit().map_err(err)?;
            Ok(count)
        })();
        if let Err(ref reason) = outcome {
            let db = state.connection.lock().map_err(err)?;
            db.execute("UPDATE scan_history SET status='failed',error=?1 WHERE id=?2", params![reason,id]).map_err(|e| format!("{reason}；扫描历史保存失败：{e}"))?;
        }
        outcome
    }).await.map_err(err).and_then(|r| r);
    app.state::<Store>().scanning.store(false, Ordering::SeqCst);
    result
}

fn validate_memory(memory: &Memory) -> Result<()> {
    if memory.title.trim().is_empty() || memory.title.len() > 2000 { return Err("请填写有效的片段标题".into()); }
    if !memory.start.is_finite() || !memory.end.is_finite() || memory.start < 0.0 || memory.end <= memory.start {
        return Err("片段的起止时间无效".into());
    }
    Ok(())
}

#[tauri::command]
async fn save_memory(memory: Memory, app: tauri::AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        validate_memory(&memory)?;
        let state = app.state::<Store>();
        let source: String = {
            let db = state.connection.lock().map_err(err)?;
            db.query_row("SELECT path FROM recordings WHERE id=?1",[&memory.recording_id],|r| r.get(0)).map_err(err)?
        };
        let tools = audio::Tools::discover(app.path().resource_dir().ok().as_deref())?;
        audio::valid_range(memory.start,memory.end,tools.duration(Path::new(&source))?)?;
        let db = state.connection.lock().map_err(err)?;
        let body = serde_json::to_string(&memory).map_err(err)?;
        db.execute("INSERT INTO memories(id,recording_id,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET recording_id=excluded.recording_id,body=excluded.body", params![memory.id,memory.recording_id,body]).map_err(err)?;
        Ok(())
    }).await.map_err(err)?
}

#[tauri::command]
fn set_saved(id: String, saved: bool, state: tauri::State<Store>) -> Result<Memory> {
    update_memory_state(&state, &id, Some(saved))
}

#[tauri::command]
fn record_listen(id: String, state: tauri::State<Store>) -> Result<Memory> {
    update_memory_state(&state, &id, None)
}

fn update_memory_state(state: &Store, id: &str, saved: Option<bool>) -> Result<Memory> {
    let db = state.connection.lock().map_err(err)?;
    let body: String = db.query_row("SELECT body FROM memories WHERE id=?1",[id],|r|r.get(0)).map_err(err)?;
    let mut memory: Memory = serde_json::from_str(&body).map_err(err)?;
    if let Some(saved) = saved { memory.saved = saved; } else { memory.listens = memory.listens.saturating_add(1); }
    db.execute("UPDATE memories SET body=?1 WHERE id=?2",params![serde_json::to_string(&memory).map_err(err)?,id]).map_err(err)?;
    Ok(memory)
}

#[tauri::command]
async fn get_waveform(id: String, app: tauri::AppHandle) -> Result<audio::Waveform> {
    tauri::async_runtime::spawn_blocking(move || -> Result<audio::Waveform> {
        let state = app.state::<Store>();
        // Serialize decodes to keep long-file browsing from exhausting CPU/memory.
        let _decode = state.waveform_lock.lock().map_err(err)?;
        let source: String = {
            let db = state.connection.lock().map_err(err)?;
            db.query_row("SELECT path FROM recordings WHERE id=?1",[&id],|r|r.get(0)).map_err(err)?
        };
        let path = Path::new(&source);
        let fingerprint = audio::fingerprint(path)?;
        let cached: Option<String> = {
            let db = state.connection.lock().map_err(err)?;
            db.query_row("SELECT body FROM waveforms WHERE recording_id=?1 AND fingerprint=?2",params![id,fingerprint],|r|r.get(0)).optional().map_err(err)?
        };
        if let Some(body) = cached { if let Ok(waveform) = serde_json::from_str(&body) { return Ok(waveform); } }
        let waveform = audio::Tools::discover(app.path().resource_dir().ok().as_deref())?.waveform(path)?;
        if audio::fingerprint(path)? != fingerprint { return Err("录音在分析期间发生变化，请重新扫描后重试。".into()); }
        let db = state.connection.lock().map_err(err)?;
        db.execute("INSERT INTO waveforms(recording_id,fingerprint,body) VALUES(?1,?2,?3) ON CONFLICT(recording_id) DO UPDATE SET fingerprint=excluded.fingerprint,body=excluded.body",params![id,fingerprint,serde_json::to_string(&waveform).map_err(err)?]).map_err(err)?;
        Ok(waveform)
    }).await.map_err(err)?
}

#[tauri::command]
async fn get_v1_waveform(path: String, app: tauri::AppHandle) -> Result<audio::Waveform> {
    check_v1_clip(path.clone(), app.clone())?;
    tauri::async_runtime::spawn_blocking(move || -> Result<audio::Waveform> {
        let state = app.state::<Store>();
        let _decode = state.waveform_lock.lock().map_err(err)?;
        let path = fs::canonicalize(path).map_err(err)?;
        let key = path.to_string_lossy().into_owned();
        let fingerprint = audio::fingerprint(&path)?;
        let cached: Option<String> = {
            let db = state.connection.lock().map_err(err)?;
            db.query_row("SELECT body FROM v1_waveforms WHERE path=?1 AND fingerprint=?2", params![key, fingerprint], |r| r.get(0)).optional().map_err(err)?
        };
        if let Some(body) = cached { if let Ok(waveform) = serde_json::from_str(&body) { return Ok(waveform); } }
        let waveform = audio::Tools::discover(app.path().resource_dir().ok().as_deref())?.waveform(&path)?;
        if audio::fingerprint(&path)? != fingerprint { return Err("音频在分析期间发生变化，请重试".into()); }
        let db = state.connection.lock().map_err(err)?;
        db.execute("INSERT INTO v1_waveforms(path,fingerprint,body) VALUES(?1,?2,?3) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint,body=excluded.body", params![key,fingerprint,serde_json::to_string(&waveform).map_err(err)?]).map_err(err)?;
        Ok(waveform)
    }).await.map_err(err)?
}

#[tauri::command]
async fn export_clip(id: String, app: tauri::AppHandle) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        let state = app.state::<Store>();
        let (memory, source, output) = {
            let db = state.connection.lock().map_err(err)?;
            let body: String = db.query_row("SELECT body FROM memories WHERE id=?1", [&id], |r| r.get(0)).map_err(err)?;
            let memory: Memory = serde_json::from_str(&body).map_err(err)?;
            let source: String = db.query_row("SELECT path FROM recordings WHERE id=?1", [&memory.recording_id], |r| r.get(0)).map_err(err)?;
            let output = setting(&db, "output")?.ok_or("请先在左下角选择输出位置")?;
            (memory, source, output)
        };
        validate_memory(&memory)?;
        if !Path::new(&source).is_file() { return Err("原始录音已移动或不可访问，请恢复原文件后重试。".into()); }
        let tools = audio::Tools::discover(app.path().resource_dir().ok().as_deref())?;
        let clips = Path::new(&output).join("clips");
        fs::create_dir_all(&clips).map_err(err)?;
        let clip_id = Uuid::new_v4().to_string();
        let destination = clips.join(format!("{}.wav", clip_id));
        let temporary = clips.join(format!("{}.partial.wav", clip_id));
        if let Err(error) = tools.extract(Path::new(&source), &temporary, memory.start, memory.end) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        fs::rename(&temporary, &destination).map_err(err)?;
        let path = destination.to_string_lossy().into_owned();
        let db = state.connection.lock().map_err(err)?;
        db.execute("INSERT INTO clips(id,memory_id,path) VALUES(?1,?2,?3)", params![clip_id,memory.id,path]).map_err(err)?;
        Ok(path)
    }).await.map_err(err)?
}

// V1 exports are independent of the legacy memory table; no mock records are persisted.
#[tauri::command]
async fn export_v1_clip(clip_id: String, source: String, start: f64, end: f64, app: tauri::AppHandle) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        let state = app.state::<Store>();
        let _operation = state.source_operation.lock().map_err(err)?;
        let output = {
            let db = state.connection.lock().map_err(err)?;
            setting(&db, "output")?.ok_or("请先配置真实输出文件夹，当前未提取任何文件。")?
        };
        let source = fs::canonicalize(source).map_err(|_| "原录音不存在或无法读取".to_string())?;
        let output = fs::canonicalize(output).map_err(|_| "输出文件夹不存在或无法访问".to_string())?;
        if !output.is_dir() { return Err("输出位置不是文件夹".into()); }
        let tools = audio::Tools::discover(app.path().resource_dir().ok().as_deref())?;
        audio::valid_range(start, end, tools.duration(&source)?)?;
        let clips = output.join("clips");
        fs::create_dir_all(&clips).map_err(err)?;
        let id = Uuid::new_v4();
        let temporary = clips.join(format!("{id}.partial.wav"));
        let destination = clips.join(format!("{id}.wav"));
        {
            let db=state.connection.lock().map_err(err)?;
            resegment::register_extraction(&db,&clip_id,&source,&[&temporary,&destination])?;
        }
        let result = tools.extract(&source, &temporary, start, end).and_then(|_| {
            // Publish only a verified file, without replacing any existing path.
            fs::hard_link(&temporary, &destination).map_err(err)
        });
        let _ = fs::remove_file(&temporary);
        result?;
        app.asset_protocol_scope().allow_file(&destination).map_err(err)?;
        Ok(destination.to_string_lossy().into_owned())
    }).await.map_err(err)?
}

#[tauri::command]
fn report_playback_error(app: tauri::AppHandle, detail: serde_json::Value) -> Result<()> {
    let text = detail.to_string();
    if text.len() > 4096 { return Err("播放诊断过长".into()); }
    fs::write(app.path().app_data_dir().map_err(err)?.join("last-playback-error.json"), text).map_err(err)
}

#[tauri::command]
fn check_v1_clip(path: String, app: tauri::AppHandle) -> Result<()> {
    if !app.asset_protocol_scope().is_allowed(&path) {
        return Err("此文件尚未获准用于回听".into());
    }
    let file = fs::File::open(&path).map_err(|_| "提取文件不存在或无法读取".to_string())?;
    if !file.metadata().map_err(err)?.is_file() { return Err("提取文件不可用".into()); }
    Ok(())
}

#[tauri::command]
async fn reveal_v1_clip(path: String, app: tauri::AppHandle) -> Result<()> {
    check_v1_clip(path.clone(), app)?;
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let path = fs::canonicalize(path).map_err(|_| "提取文件不存在或无法读取".to_string())?;
            let status = std::process::Command::new("/usr/bin/open")
                .arg("-R").arg(path).status().map_err(|_| "无法打开 Finder，请重试".to_string())?;
            if status.success() { Ok(()) } else { Err("无法在 Finder 中定位文件，请重试".into()) }
        }).await.map_err(err)?
    }
    #[cfg(not(target_os = "macos"))]
    { Err("当前仅支持在 macOS 中查看文件".into()) }
}

fn read_v1_library(db: &Connection) -> Result<Option<serde_json::Value>> {
    let body: Option<String> = db.query_row("SELECT body FROM v1_library WHERE id=1", [], |row| row.get(0)).optional().map_err(err)?;
    body.map(|body| serde_json::from_str(&body).map_err(err)).transpose()
}

fn write_v1_library(db: &Connection, library: &serde_json::Value) -> Result<()> {
    if library["version"].as_u64() != Some(1) || !library["items"].is_array() { return Err("片段记录格式不受支持".into()); }
    db.execute("INSERT INTO v1_library(id,body) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body", [library.to_string()]).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn save_v1_library(mut library: serde_json::Value, state: tauri::State<Store>) -> Result<()> {
    let db = state.connection.lock().map_err(err)?;
    queue::preserve_new_items(&db, &mut library)?;
    source_trash::overlay(&db, &mut library)?;
    write_v1_library(&db, &library)
}

#[tauri::command]
fn load_v1_library(app: tauri::AppHandle, state: tauri::State<Store>) -> Result<Option<serde_json::Value>> {
    let db = state.connection.lock().map_err(err)?;
    let mut library = read_v1_library(&db)?;
    if let Some(items) = library.as_mut().and_then(|data| data["items"].as_array_mut()) {
        for item in items {
            if let Some(path) = item["sourcePath"].as_str().map(str::to_owned) {
                app.asset_protocol_scope().allow_file(&path).map_err(err)?;
                item["sourceAvailable"] = Path::new(&path).is_file().into();
            }
            if let Some(path) = item["clipPath"].as_str().map(str::to_owned) {
                app.asset_protocol_scope().allow_file(&path).map_err(err)?;
                item["clipMissing"] = (!Path::new(&path).is_file()).into();
            }
        }
    }
    if let Some(value) = library.as_mut() { source_trash::overlay(&db, value)?; }
    Ok(library)
}

pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("media", |context, request, responder| {
            let app=context.app_handle().clone();
            std::thread::spawn(move || responder.respond(media::respond(&app, request)));
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(exit_guard::ExitGuard::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if exit_guard::intercept(window.app_handle()) { api.prevent_close(); }
            }
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "safe-quit" && !exit_guard::intercept(app) { app.exit(0); }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let menu = tauri::menu::Menu::default(app.handle())?;
                if let Some(tauri::menu::MenuItemKind::Submenu(submenu)) = menu.items()?.first() {
                    let count = submenu.items()?.len();
                    submenu.remove_at(count - 1)?;
                    submenu.append(&tauri::menu::MenuItem::with_id(app, "safe-quit", "退出 Once More", true, Some("CmdOrCtrl+Q"))?)?;
                }
                app.set_menu(menu)?;
            }
            let directory = app.path().app_data_dir()?;
            fs::create_dir_all(&directory)?;
            app.manage(model::ModelManager::initialize(directory.join("models")));
            let db = Connection::open(directory.join("once-more.sqlite3"))?;
            initialize(&db).map_err(std::io::Error::other)?;
            transcription::initialize(&db).map_err(std::io::Error::other)?;
            app.manage(transcription::Worker::default());
            app.manage(queue::Runner::default());
            app.manage(Store { connection: Mutex::new(db), scanning: AtomicBool::new(false), waveform_lock: Mutex::new(()), source_operation: Mutex::new(()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![resegment::clear_processing_results,resegment::resegment_recording,resegment::retired_clip_ids,exit_guard::resolve_processing_exit,queue::processing_status,queue::set_processing_seconds,queue::enqueue_processing,queue::retry_processing,queue::run_processing,source_trash::trash_source,source_check::check_source_clips,pause::repair_pause_text,pause::preview_pause_segments,transcription::list_transcriptions,transcription::start_transcription,transcription::read_transcription,transcription::task_assets,model::get_model_status,model::download_model,load_snapshot,set_folder,get_v1_folders,get_v1_scan_time,get_scan_history,scan_recordings,save_memory,set_saved,record_listen,get_waveform,get_v1_waveform,export_clip,export_v1_clip,report_playback_error,check_v1_clip,reveal_v1_clip,load_v1_library,save_v1_library])
        .build(tauri::generate_context!())
        .expect("Unable to start Once More")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => { if exit_guard::intercept(app) { api.prevent_exit(); } },
                tauri::RunEvent::Exit => processes::shutdown(),
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v1_records_survive_reopen_without_touching_legacy_records() {
        let path = std::env::temp_dir().join(format!("once-more-v1-{}.sqlite3", Uuid::new_v4()));
        let value = serde_json::json!({"version":1,"items":[{"id":"sample","saved":true,"start":3,"duration":2,"clipPath":"/clip.wav"}]});
        {
            let db = Connection::open(&path).unwrap();
            initialize(&db).unwrap();
            db.execute("INSERT INTO recordings VALUES('existing','/source.wav','source.wav',0,10)", []).unwrap();
            write_v1_library(&db, &value).unwrap();
            assert!(write_v1_library(&db, &serde_json::json!({"version":2,"items":[]})).is_err());
        }
        {
            let db = Connection::open(&path).unwrap();
            initialize(&db).unwrap();
            assert_eq!(read_v1_library(&db).unwrap(), Some(value));
            assert_eq!(db.query_row("SELECT count(*) FROM recordings", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        }
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn scan_history_reopens_and_preserves_failures_and_interruptions() {
        let path = std::env::temp_dir().join(format!("once-more-history-{}.sqlite3", Uuid::new_v4()));
        {
            let db = Connection::open(&path).unwrap(); initialize(&db).unwrap();
            db.execute("INSERT INTO scan_history VALUES('failed','/original',1,'failed',NULL,'missing')", []).unwrap();
            db.execute("INSERT INTO scan_history VALUES('retry','/original',2,'succeeded',3,NULL)", []).unwrap();
            db.execute("INSERT INTO scan_history VALUES('interrupted','/original',3,'running',NULL,NULL)", []).unwrap();
        }
        {
            let db = Connection::open(&path).unwrap(); initialize(&db).unwrap();
            let rows = scan_history(&db).unwrap();
            assert_eq!(rows.len(), 3);
            assert_eq!(rows[0].status, "failed");
            assert!(rows[0].error.as_ref().unwrap().contains("中断"));
            assert_eq!(rows[1].count, Some(3));
            assert_eq!(rows[2].error.as_deref(), Some("missing"));
            assert_eq!(rows[2].source.as_deref(), Some("/original"));
        }
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn discovery_filters_extensions_and_rejects_missing_source() {
        let root = std::env::temp_dir().join(format!("once-more-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/audio.M4A"), b"fixture").unwrap();
        fs::write(root.join("note.txt"), b"ignored").unwrap();
        let found = discover_recordings(root.to_str().unwrap()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "audio.M4A");
        assert!(discover_recordings(root.join("note.txt").to_str().unwrap()).is_err());
        fs::remove_dir_all(&root).unwrap();
        assert!(discover_recordings(root.to_str().unwrap()).is_err());
    }
    #[test]
    fn folder_status_preserves_missing_path_and_recovers() {
        let path = std::env::temp_dir().join(format!("once-more-folder-{}", Uuid::new_v4()));
        let value = path.to_string_lossy().into_owned();
        let missing = folder_status(Some(value.clone()));
        assert_eq!(missing.path.as_deref(), Some(value.as_str()));
        assert!(missing.error.is_some());
        fs::create_dir(&path).unwrap();
        assert!(folder_status(Some(value.clone())).error.is_none());
        fs::remove_dir(&path).unwrap();
        assert!(folder_status(Some(value)).error.is_some());
        assert!(folder_status(None).error.is_none());
    }
    #[test]
    fn duplicate_scan_preserves_recording_and_memory() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        db.execute("INSERT INTO recordings VALUES('r','/audio.wav','audio.wav',0,100)", []).unwrap();
        db.execute("INSERT INTO memories VALUES('m','r','{}')", []).unwrap();
        db.execute("INSERT INTO recordings VALUES('r2','/audio.wav','audio.wav',1,200) ON CONFLICT(path) DO UPDATE SET size=excluded.size", []).unwrap();
        let id: String = db.query_row("SELECT id FROM recordings",[],|r| r.get(0)).unwrap();
        assert_eq!(id,"r");
        assert!(db.execute("INSERT INTO memories VALUES('bad','missing','{}')",[]).is_err());
    }
}
