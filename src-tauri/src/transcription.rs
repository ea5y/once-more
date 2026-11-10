use crate::{audio::Tools, err, model::ModelManager, simplified, Result, Store};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, process::Stdio, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use tauri::Manager;
#[derive(Default)]
pub struct Worker(pub(crate) AtomicBool);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item { id: String, name: String, phase: String, error: Option<String>, duration: Option<f64> }
#[derive(Serialize, Deserialize, Debug)]
pub struct Segment { pub start: f64, pub end: f64, pub text: String }
pub fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS local_transcriptions(recording_id TEXT PRIMARY KEY REFERENCES recordings(id), phase TEXT NOT NULL, error TEXT, duration REAL, body TEXT, fingerprint TEXT); UPDATE local_transcriptions SET phase='failed',error='上次转写被中断，请重试' WHERE phase IN ('preparing','transcribing','verifying');").map_err(err)
}
#[tauri::command]
pub fn list_transcriptions(state: tauri::State<Store>) -> Result<Vec<Item>> {
    let db = state.connection.lock().map_err(err)?;
    let mut query = db.prepare("SELECT r.id,r.name,COALESCE(t.phase,'pending'),t.error,t.duration FROM recordings r LEFT JOIN local_transcriptions t ON t.recording_id=r.id ORDER BY r.modified DESC").map_err(err)?;
    let rows = query.query_map([], |r| Ok(Item { id:r.get(0)?, name:r.get(1)?, phase:r.get(2)?, error:r.get(3)?, duration:r.get(4)? })).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
    Ok(rows)
}
#[tauri::command]
pub fn read_transcription(state: tauri::State<Store>, id: String) -> Result<Vec<Segment>> {
    let db = state.connection.lock().map_err(err)?;
    let body: String = db.query_row("SELECT body FROM local_transcriptions WHERE recording_id=?1 AND phase='completed'", [id], |r| r.get(0)).map_err(|_| "尚无已保存的全文".to_string())?;
    serde_json::from_str(&body).map_err(err)
}
pub(crate) fn fingerprint(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path).map_err(|_| "原录音已移动或不可访问，请恢复后重试".to_string())?;
    Ok(format!("{}:{:?}", metadata.len(), metadata.modified().map_err(err)?))
}
pub(crate) fn engine(resources: &Path) -> Result<PathBuf> {
    let path = resources.join("binaries/whisper-cli");
    if path.is_file() { return Ok(path); }
    if cfg!(debug_assertions) {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/whisper-cli");
        if path.is_file() { return Ok(path); }
    }
    Err("本地转写引擎缺失，请重新安装完整应用".into())
}
const VAD_NAME: &str = "ggml-silero-v5.1.2.bin";
const VAD_SHA256: &str = "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf";
// Invalidate pre-VAD cached output without altering previously saved transcripts.
fn result_key(source: &str) -> String { format!("vad-v3:retry-repeat8:windows30:ml60:mc0:{VAD_SHA256}:{source}") }
fn vad_model(binary: &Path) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let path = binary.parent().ok_or("转写引擎位置无效")?.join(VAD_NAME);
    let bytes = fs::read(&path).map_err(|_| "人声检测模型缺失，请重新安装完整应用".to_string())?;
    if format!("{:x}", Sha256::digest(&bytes)) != VAD_SHA256 { return Err("人声检测模型校验失败，请重新安装完整应用".into()); }
    Ok(path)
}

// Recognition windows are internal; product clips still use the configured pause rule.
fn recognition_windows(duration: f64, pauses: &[crate::pause::Cut]) -> Vec<(f64, f64)> {
    let mut windows = Vec::new();
    let mut start = 0.0;
    while start < duration {
        let limit = (start + 30.0).min(duration);
        let end = if limit == duration { duration } else {
            pauses.iter().map(|p| (p.start+p.end)/2.0)
                .filter(|p| *p >= start+15.0 && *p <= limit)
                .max_by(f64::total_cmp).unwrap_or(limit)
        };
        windows.push((start, end)); start = end;
    }
    windows
}

fn parse(bytes: &[u8], duration: f64) -> Result<Vec<Segment>> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(err)?;
    let rows = value["transcription"].as_array().ok_or("转写结果格式不完整")?;
    if !duration.is_finite() || duration <= 0.0 { return Err("音频时长无效".into()); }
    let mut segments = Vec::new();
    let mut previous = 0.0;
    for (index, row) in rows.iter().enumerate() {
        let start = row["offsets"]["from"].as_f64().ok_or("缺少开始时间")? / 1000.0;
        let end = row["offsets"]["to"].as_f64().ok_or("缺少结束时间")? / 1000.0;
        // Only tolerate small end-of-file drift on the final sentence.
        let tail_drift = index + 1 == rows.len() && end > duration && end <= duration + 3.0;
        if !start.is_finite() || !end.is_finite() || start < previous || start >= duration
            || end < start || (end > duration && !tail_drift) {
            return Err("转写时间戳无效，未保存不完整结果".into());
        }
        let end = end.min(duration);
        let text = row["text"].as_str().ok_or("缺少转写文字")?;
        segments.push(Segment { start, end, text: simplified::convert(text)? });
        previous = start;
    }
    Ok(segments)
}
fn suspicious_repetition(rows: &[Segment]) -> bool {
    let mut previous = String::new();
    let mut run = 0;
    for row in rows {
        let text: String = row.text.chars().filter(|c| c.is_alphanumeric()).collect();
        if text.chars().count() >= 2 && text == previous { run += 1; } else { run = 1; }
        if text.chars().count() >= 2 && run >= 8 { return true; }
        previous = text;
    }
    false
}

fn collect_window_results(binary: &Path, model: &Path, chunks: &Path, windows: &[(f64,f64)]) -> Result<Vec<Segment>> {
    let mut rows = Vec::new();
    for (index, &(start,end)) in windows.iter().enumerate() {
        let mut local = parse(&fs::read(chunks.join(format!("{index}.json"))).map_err(err)?, end-start)?;
        if suspicious_repetition(&local) {
            // Keep original VAD output. Retry this window once with its pauses intact.
            let output=chunks.join(format!("{index}-direct"));
            let log=fs::File::create(chunks.join(format!("{index}-direct.log"))).map_err(err)?;
            let status=crate::processes::status(crate::processes::command(binary).arg("-m").arg(model)
                .arg("-f").arg(chunks.join(format!("{index}.wav")))
                .args(["-l","zh","-t","4","-mc","0","-ml","60","-oj","-of"]).arg(&output)
                .stdout(Stdio::null()).stderr(log)).map_err(err)?;
            if !status.success() { return Err("异常短段复查失败，原录音和转写结果已保留".into()); }
            let retry=parse(&fs::read(output.with_extension("json")).map_err(err)?,end-start)?;
            if retry.is_empty() || suspicious_repetition(&retry) {
                return Err(format!("录音约第 {} 秒仍有疑似重复转写，结果已保留，未自动覆盖",start.round()));
            }
            local=retry;
        }
        for mut row in local { row.start+=start;row.end+=start;rows.push(row); }
    }
    Ok(rows)
}

pub(crate) fn transcribe(tools: &Tools, binary: &Path, model: &Path, source: &Path, work: &Path, phase: impl Fn(&str, f64) -> Result<()>) -> Result<(Vec<Segment>, f64, String)> {
    fs::create_dir_all(work).map_err(err)?;
    let before = fingerprint(source)?;
    let vad = vad_model(binary)?;
    let cache_key = result_key(&before);
    let wav = work.join("audio.wav");
    let marker = work.join("source.txt");
    let duration = tools.duration(source)?;
    // A prepared local copy survives failure and is reused only for the same source fingerprint.
    if !wav.is_file() || fs::read_to_string(&marker).ok().as_deref() != Some(before.as_str()) {
        if marker.exists() { fs::remove_file(&marker).map_err(err)?; }
        tools.prepare_transcription(source, &wav)?;
        fs::write(&marker, &before).map_err(err)?;
    }
    phase("preparing", 0.0)?;
    let json = work.join("result.json");
    if json.exists() {
        if fs::read_to_string(work.join("result-source.txt")).ok().as_deref() == Some(cache_key.as_str()) {
            // Keep completed engine output even if application validation fails.
            let rows = parse(&fs::read(&json).map_err(err)?, duration)?;
            return Ok((rows,duration,before));
        }
        fs::rename(&json, work.join(format!("result-previous-{}.json", uuid::Uuid::new_v4()))).map_err(err)?;
    }
    let result_marker = work.join("result-source.txt");
    if result_marker.exists() { fs::remove_file(&result_marker).map_err(err)?; }
    let (_, pauses) = tools.pause_boundaries(&wav, 0.3)?;
    let windows = recognition_windows(duration, &pauses);
    let chunks = work.join(format!("windows-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&chunks).map_err(err)?;
    let mut inputs = Vec::new();
    for (index, &(start, end)) in windows.iter().enumerate() {
        let input = chunks.join(format!("{index}.wav"));
        tools.prepare_transcription_window(&wav, &input, start, end)?;
        inputs.push(input);
    }
    let log = fs::File::create(work.join("engine.log")).map_err(err)?;
    let mut command = crate::processes::command(binary);
    command.arg("-m").arg(model).args(["-l", "zh", "-t", "4", "-mc", "0", "--vad", "-vm"]).arg(&vad)
        .args(["-ml", "60", "-oj"]);
    // One engine invocation loads Whisper once for all windows.
    for (index, input) in inputs.iter().enumerate() {
        command.arg("-f").arg(input).arg("-of").arg(chunks.join(index.to_string()));
    }
    phase("transcribing", 0.0)?;
    let mut child = crate::processes::spawn(command.stdout(Stdio::null()).stderr(log)).map_err(err)?;
    let mut completed = 0;
    let status = loop {
        let previous = completed;
        while completed < windows.len() {
            let file = chunks.join(format!("{completed}.json"));
            let valid = fs::read(file).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok()).is_some_and(|v| v["transcription"].is_array());
            if !valid { break; }
            completed += 1;
        }
        if completed > previous { phase("transcribing", completed_percent(&windows,completed,duration))?; }
        if let Some(status) = child.try_wait().map_err(err)? { break status; }
        std::thread::sleep(std::time::Duration::from_millis(250));
    };
    if !status.success() { return Err("本地转写未完成，请重试；原录音保留".into()); }
    if fingerprint(source)? != before { return Err("转写期间原录音发生变化，请重试".into()); }
    phase("verifying", 100.0)?;
    let rows = collect_window_results(binary, model, &chunks, &windows)?;
    if fingerprint(source)? != before { return Err("转写期间原录音发生变化，请重试".into()); }
    let raw: Vec<_> = rows.iter().map(|r| serde_json::json!({"offsets":{"from":r.start*1000.0,"to":r.end*1000.0},"text":r.text})).collect();
    fs::write(&json, serde_json::to_vec(&serde_json::json!({"transcription":raw})).map_err(err)?).map_err(err)?;
    fs::write(result_marker, &cache_key).map_err(err)?;
    let rows = parse(&fs::read(&json).map_err(err)?, duration)?;
    Ok((rows, duration, before))
}
#[tauri::command]
pub fn start_transcription(app: tauri::AppHandle, id: String) -> Result<()> {
    let model = app.state::<Arc<ModelManager>>().ready_path()?;
    let resources = app.path().resource_dir().map_err(err)?;
    let binary = engine(&resources)?;
    let tools = Tools::discover(Some(&resources))?;
    let directory = app.path().app_data_dir().map_err(err)?.join("transcription-work");
    let source: String = {
        let store = app.state::<Store>(); let db = store.connection.lock().map_err(err)?;
        let completed: Option<String> = db.query_row("SELECT phase FROM local_transcriptions WHERE recording_id=?1", [&id], |r| r.get(0)).optional().map_err(err)?;
        if completed.as_deref() == Some("completed") { return Err("这条录音已转写，可直接查看全文".into()); }
        db.query_row("SELECT path FROM recordings WHERE id=?1", [&id], |r| r.get(0)).map_err(|_| "录音未登记，请先扫描".to_string())?
    };
    // IDs originate from the DB but validate before using them as cache directory names.
    uuid::Uuid::parse_str(&id).map_err(|_| "录音标识无效".to_string())?;
    if app.state::<Worker>().0.swap(true, Ordering::SeqCst) { return Err("已有录音正在转写，请稍候".into()); }
    let begin = (|| {
        let store = app.state::<Store>(); let db = store.connection.lock().map_err(err)?;
        db.execute("INSERT INTO local_transcriptions(recording_id,phase) VALUES(?1,'preparing') ON CONFLICT(recording_id) DO UPDATE SET phase='preparing',error=NULL", [&id]).map_err(err)?;
        Ok(())
    })();
    if let Err(e) = begin { app.state::<Worker>().0.store(false, Ordering::SeqCst); return Err(e); }
    std::thread::spawn(move || {
        struct Reset(tauri::AppHandle);
        impl Drop for Reset { fn drop(&mut self) { self.0.state::<Worker>().0.store(false, Ordering::SeqCst); } }
        let _reset = Reset(app.clone());
        let work = directory.join(&id);
        let result = (|| -> Result<()> {
            let (segments, duration, fingerprint) = transcribe(&tools, &binary, &model, Path::new(&source), &work, |phase, _progress| {
                let store = app.state::<Store>(); let db = store.connection.lock().map_err(err)?;
                db.execute("UPDATE local_transcriptions SET phase=?1 WHERE recording_id=?2", params![phase,id]).map_err(err)?; Ok(())
            })?;
            let body = serde_json::to_string(&segments).map_err(err)?;
            let store = app.state::<Store>(); let db = store.connection.lock().map_err(err)?;
            db.execute("UPDATE local_transcriptions SET phase='completed',error=NULL,body=?1,duration=?2,fingerprint=?3 WHERE recording_id=?4", params![body,duration,fingerprint,id]).map_err(err)?;
            // Only remove generated files after the complete result has been saved.
            let _ = fs::remove_dir_all(&work);
            Ok(())
        })();
        if crate::processes::closing() { return; }
        if let Err(reason) = result {
            let store = app.state::<Store>();
            if let Ok(db) = store.connection.lock() { let _ = db.execute("UPDATE local_transcriptions SET phase='failed',error=?1 WHERE recording_id=?2", params![reason,id]); };
        }
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timestamp_validation_and_simplification() {
        let data = br#"{"transcription":[{"offsets":{"from":1000,"to":2000},"text":"Whisper YK 3288"}]}"#;
        let rows = parse(data, 2.0).unwrap(); assert_eq!(rows[0].start, 1.0); assert_eq!(rows[0].text, "Whisper YK 3288");
        assert!(parse(data, 0.1).is_err());
        assert!(parse(br#"{"transcription":[{"text":"x"}]}"#, 2.0).is_err());
    }
    #[test]
    fn final_timestamp_drift_is_clamped_without_losing_text() {
        let data = br#"{"transcription":[{"offsets":{"from":8175660,"to":8205640},"text":"last sentence"}]}"#;
        let rows = parse(data, 8203.754667).unwrap();
        assert_eq!(rows[0].end, 8203.754667);
        assert_eq!(rows[0].text, "last sentence");
        assert!(parse(data, 8200.0).is_err());
        for offsets in [(2000,1000),(3000,4000),(-1000,1000)] {
            let data = serde_json::json!({"transcription":[{"offsets":{"from":offsets.0,"to":offsets.1},"text":"x"}]}).to_string();
            assert!(parse(data.as_bytes(), 3.0).is_err());
        }
        let earlier_overrun = br#"{"transcription":[{"offsets":{"from":0,"to":4000},"text":"x"},{"offsets":{"from":1000,"to":2000},"text":"y"}]}"#;
        assert!(parse(earlier_overrun, 3.0).is_err());
    }
    #[test]
    fn vad_result_keeps_original_time_and_accepts_no_speech() {
        assert!(parse(br#"{"transcription":[]}"#, 30.0).unwrap().is_empty());
        let rows=parse(br#"{"transcription":[{"offsets":{"from":10500,"to":12220},"text":"hello"},{"offsets":{"from":56930,"to":58460},"text":"world"}]}"#,60.0).unwrap();
        assert_eq!(rows[0].start,10.5);assert_eq!(rows[1].start,56.93);
        assert_ne!(result_key("source"),"source");
        assert_ne!(result_key("source"),result_key("changed-source"));
    }
    #[test]
    fn recognition_windows_cover_audio_once_with_bounded_duration() {
        let cuts=vec![crate::pause::Cut{start:19.0,end:21.0},crate::pause::Cut{start:44.0,end:46.0}];
        let parts=recognition_windows(91.25,&cuts);
        assert_eq!(parts[0],(0.0,20.0));assert_eq!(parts[1],(20.0,45.0));
        assert_eq!(parts.last().unwrap().1,91.25);
        for (i,(start,end)) in parts.iter().enumerate() {
            assert!(*end>*start && end-start<=30.0);
            if i>0 {assert_eq!(*start,parts[i-1].1);}
        }
        assert_eq!(recognition_windows(60.0,&[]),vec![(0.0,30.0),(30.0,60.0)]);
    }
    #[test]
    #[ignore = "explicit local audio check; requires ONCE_MORE_CHECK_SOURCE, MODEL and WORK"]
    fn real_windowed_transcription_and_cached_retry() {
        let source=PathBuf::from(std::env::var("ONCE_MORE_CHECK_SOURCE").unwrap());
        let model=PathBuf::from(std::env::var("ONCE_MORE_CHECK_MODEL").unwrap());
        let work=PathBuf::from(std::env::var("ONCE_MORE_CHECK_WORK").unwrap());
        let resources=Path::new(env!("CARGO_MANIFEST_DIR"));
        let tools=Tools::discover(Some(resources)).unwrap();
        let binary=engine(resources).unwrap();
        let before=fingerprint(&source).unwrap();
        let events=std::cell::RefCell::new(Vec::new());
        let started=std::time::Instant::now();
        let (rows,duration,_)=transcribe(&tools,&binary,&model,&source,&work,|stage,percent|{events.borrow_mut().push(serde_json::json!({"stage":stage,"percent":percent,"elapsed":started.elapsed().as_secs_f64()}));Ok(())}).unwrap();
        if std::env::var_os("ONCE_MORE_VERIFY_PROGRESS").is_some() {
            let events=events.borrow();
            let percentages:Vec<f64>=events.iter().filter(|e|e["stage"]=="transcribing").map(|e|e["percent"].as_f64().unwrap()).collect();
            assert_eq!(percentages.first(),Some(&0.0));
            assert!(percentages.iter().any(|p|*p>0.0 && *p<100.0));
            assert!(percentages.windows(2).all(|p|p[1]>=p[0]));
            assert_eq!(events.last().unwrap()["stage"],"verifying");
            fs::write(work.join("progress-events.json"),serde_json::to_vec_pretty(&*events).unwrap()).unwrap();
            println!("Actual progress events: {}",serde_json::to_string(&*events).unwrap());
        }
        assert_eq!(fingerprint(&source).unwrap(),before);
        assert!(rows.iter().all(|r|r.end-r.start<=30.001 && !r.text.contains('\u{fffd}')));
        let (cached,cached_duration,_)=transcribe(&tools,&binary.with_file_name("missing-engine"),&model,&source,&work,|_,_|Ok(())).unwrap();
        assert_eq!(duration,cached_duration);
        assert_eq!(serde_json::to_string(&rows).unwrap(),serde_json::to_string(&cached).unwrap());
        println!("Verified {} rows over {} seconds; source unchanged; retry used cache",rows.len(),duration);
    }
    #[test]
    fn repetition_guard_only_requests_retry_never_removes_text() {
        let repeated=|text:&str,n:usize|(0..n).map(|i|Segment{start:i as f64,end:i as f64+1.0,text:text.into()}).collect::<Vec<_>>();
        assert!(suspicious_repetition(&repeated("你再一份",8)));
        assert!(!suspicious_repetition(&repeated("你再一份",7)));
        assert!(!suspicious_repetition(&repeated("嗯",20)));
        let mut separated=repeated("重复",7);separated.push(Segment{start:7.0,end:8.0,text:"不同的话".into()});separated.extend(repeated("重复",7));
        assert!(!suspicious_repetition(&separated));
    }
    #[test]
    #[ignore = "explicit local saved-window validation; requires ONCE_MORE_CHECK_WORK and MODEL"]
    fn repair_saved_window_outputs() {
        let work=PathBuf::from(std::env::var("ONCE_MORE_CHECK_WORK").unwrap());
        let model=PathBuf::from(std::env::var("ONCE_MORE_CHECK_MODEL").unwrap());
        let resources=Path::new(env!("CARGO_MANIFEST_DIR"));let tools=Tools::discover(Some(resources)).unwrap();
        let source=work.join("audio.wav");let before=fingerprint(&source).unwrap();
        let duration=tools.duration(&source).unwrap();let (_,pauses)=tools.pause_boundaries(&source,0.3).unwrap();
        let windows=recognition_windows(duration,&pauses);
        let chunks=work.join(std::env::var("ONCE_MORE_CHECK_CHUNKS").unwrap());
        let rows=collect_window_results(&engine(resources).unwrap(),&model,&chunks,&windows).unwrap();
        assert_eq!(fingerprint(&source).unwrap(),before);
        assert!(rows.iter().all(|r|r.end-r.start<=30.001 && !r.text.contains('\u{fffd}')));
        fs::write(work.join("corrected-segments.json"),serde_json::to_vec(&rows).unwrap()).unwrap();
        println!("Rechecked {} rows from {} saved windows; original output preserved",rows.len(),windows.len());
    }
    #[test]
    fn interrupted_task_preserves_completed_results() {
        let db = Connection::open_in_memory().unwrap(); crate::initialize(&db).unwrap(); initialize(&db).unwrap();
        db.execute("INSERT INTO recordings VALUES('a','/a','a',0,1)", []).unwrap();
        db.execute("INSERT INTO recordings VALUES('b','/b','b',0,1)", []).unwrap();
        db.execute("INSERT INTO local_transcriptions(recording_id,phase,body) VALUES('a','completed','[]'),('b','transcribing',NULL)", []).unwrap();
        initialize(&db).unwrap();
        assert_eq!(db.query_row("SELECT phase FROM local_transcriptions WHERE recording_id='b'", [], |r|r.get::<_,String>(0)).unwrap(), "failed");
        assert_eq!(db.query_row("SELECT body FROM local_transcriptions WHERE recording_id='a'", [], |r|r.get::<_,String>(0)).unwrap(), "[]");
    }
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAssets { transcript_ready: bool, source_exists: Option<bool> }
#[tauri::command]
pub fn task_assets(state: tauri::State<Store>, id: String) -> Result<TaskAssets> {
    let (path, ready): (String, bool) = {
        let db = state.connection.lock().map_err(err)?;
        db.query_row("SELECT r.path, EXISTS(SELECT 1 FROM local_transcriptions t WHERE t.recording_id=r.id AND t.phase='completed' AND t.body IS NOT NULL) FROM recordings r WHERE r.id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?
    };
    Ok(TaskAssets { transcript_ready: ready, source_exists: Path::new(&path).try_exists().ok() })
}

fn completed_percent(windows:&[(f64,f64)],completed:usize,duration:f64)->f64 {
    if duration<=0.0 {return 0.0;}
    (windows.iter().take(completed).map(|(a,b)|b-a).sum::<f64>()/duration*100.0).floor().clamp(0.0,100.0)
}
#[cfg(test)]
mod progress_tests {
 #[test] fn weights_audio_duration_not_window_count(){
 assert_eq!(super::completed_percent(&[(0.0,10.0),(10.0,40.0)],1,40.0),25.0);
 assert_eq!(super::completed_percent(&[(0.0,10.0),(10.0,40.0)],2,40.0),100.0);
 }
}
