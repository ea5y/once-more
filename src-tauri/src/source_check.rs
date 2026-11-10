use crate::{audio, err, read_v1_library, Result, Store};
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::Path};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check { source_id: String, pub(crate) ready: bool, checked: usize, total: usize, pub(crate) errors: Vec<String> }

fn range(item: &Value) -> Result<f64> {
    let start = item["start"].as_f64().ok_or("缺少起点")?;
    let duration = item["duration"].as_f64().ok_or("缺少时长")?;
    if !start.is_finite() || start < 0.0 || !duration.is_finite() || duration <= 0.0 { return Err("片段范围无效".into()); }
    if item["extraction"] != "done" || item["extractedRange"]["start"].as_f64() != Some(start)
        || item["extractedRange"]["end"].as_f64().is_none_or(|end| (end - start - duration).abs() > 0.000001) {
        return Err("尚未按最新范围提取".into());
    }
    Ok(duration)
}

pub(crate) fn inspect(library: &Value, id: &str, source: &Path, busy: bool, tools: &audio::Tools) -> Check {
    let mut result = Check { source_id: id.into(), ready: false, checked: 0, total: 0, errors: vec![] };
    if busy { result.errors.push("录音仍在处理中".into()); }
    let items = library["items"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let related: Vec<_> = items.iter().filter(|i| i["sourceId"] == id).collect();
    result.total = related.len();
    if related.is_empty() { result.errors.push("没有已保存的片段".into()); }
    let original = fs::canonicalize(source);
    if original.is_err() { result.errors.push("原录音不存在或无法访问".into()); }
    for (index, item) in related.iter().enumerate() {
        let check = (|| -> Result<()> {
            let duration = range(item)?;
            let item_source = fs::canonicalize(item["sourcePath"].as_str().ok_or("缺少来源路径")?).map_err(err)?;
            if original.as_ref().ok() != Some(&item_source) { return Err("片段来源与登记录音不一致".into()); }
            let clip = fs::canonicalize(item["clipPath"].as_str().ok_or("缺少提取文件")?).map_err(|_| "提取文件不存在或无法访问".to_string())?;
            if clip == item_source { return Err("提取文件不能是原录音本身".into()); }
            #[cfg(unix)] {
                use std::os::unix::fs::MetadataExt;
                let a = fs::metadata(&clip).map_err(err)?;
                let b = fs::metadata(&item_source).map_err(err)?;
                if a.dev() == b.dev() && a.ino() == b.ino() { return Err("提取文件不能是原录音的硬链接".into()); }
            }
            tools.verify_clip(&clip, duration)
        })();
        match check { Ok(()) => result.checked += 1, Err(e) => result.errors.push(format!("第{}段：{}", index + 1, e)) }
    }
    result.ready = result.errors.is_empty() && result.checked == result.total && result.total > 0;
    result
}

/// Read-only preflight. Never authorizes a later deletion without a fresh check.
#[tauri::command]
pub async fn check_source_clips(source_id: String, app: tauri::AppHandle) -> Result<Check> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Store>();
        let (library, source, busy) = {
            let db = state.connection.lock().map_err(err)?;
            let library = read_v1_library(&db)?.ok_or("没有已保存的片段")?;
            let source: String = db.query_row("SELECT path FROM recordings WHERE id=?1", [&source_id], |r| r.get(0)).map_err(err)?;
            let busy: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM local_transcriptions WHERE recording_id=?1 AND phase IN ('preparing','transcribing'))", [&source_id], |r| r.get(0)).map_err(err)?;
            (library, source, busy || state.scanning.load(std::sync::atomic::Ordering::SeqCst))
        };
        let tools = audio::Tools::discover(app.path().resource_dir().ok().as_deref())?;
        Ok(inspect(&library, &source_id, Path::new(&source), busy, &tools))
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_unextracted_stale_and_invalid_ranges() {
        let mut item = json!({"start":1.0,"duration":2.0,"extraction":"done","extractedRange":{"start":1.0,"end":3.0}});
        assert_eq!(range(&item).unwrap(), 2.0);
        item["start"] = json!(1.1); assert!(range(&item).is_err());
        item["start"] = json!(1.0); item["extraction"] = json!("extracting"); assert!(range(&item).is_err());
        item["duration"] = json!(0); assert!(range(&item).is_err());
    }
    #[test]
    #[ignore = "local real-audio verification; requires project verification files"]
    fn real_saved_source_is_blocked_by_unextracted_first_segment() {
        let tools = audio::Tools::discover(None).unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let file = root.join(".local/verification/library-after-reextract.json");
        if !file.exists() { return; }
        let library: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        let source = root.join(".local/verification/source/中山西路3288号 2.m4a");
        let result = inspect(&library, "311ae5b8-0aa4-4b59-b325-0016857989b1", &source, false, &tools);
        assert!(!result.ready); assert_eq!(result.total, 2); assert_eq!(result.checked, 1, "{:?}", result.errors);
        assert_eq!(result.errors, vec!["第1段：尚未按最新范围提取"]);
        let second = library["items"].as_array().unwrap().iter().find(|i| i["sourceId"] == "311ae5b8-0aa4-4b59-b325-0016857989b1" && i["extraction"] == "done").unwrap().clone();
        let id = "311ae5b8-0aa4-4b59-b325-0016857989b1";
        let valid = json!({"items":[second]});
        assert!(inspect(&valid, id, &source, false, &tools).ready);
        assert!(!inspect(&valid, id, &source, true, &tools).ready);
        assert!(!inspect(&json!({"items":[]}), id, &source, false, &tools).ready);
        let mut bad = valid.clone();
        bad["items"][0]["clipPath"] = json!(source.to_string_lossy());
        assert!(!inspect(&bad, id, &source, false, &tools).ready);
        bad["items"][0]["clipPath"] = json!(source.with_extension("missing").to_string_lossy());
        assert!(!inspect(&bad, id, &source, false, &tools).ready);
        let mut short = valid.clone();
        short["items"][0]["duration"] = json!(200.0);
        short["items"][0]["extractedRange"]["end"] = json!(257.78);
        assert!(!inspect(&short, id, &source, false, &tools).ready);
        let damaged = std::env::temp_dir().join(format!("once-check-{}.wav", uuid::Uuid::new_v4()));
        fs::write(&damaged, b"not audio").unwrap();
        bad["items"][0]["clipPath"] = json!(damaged.to_string_lossy());
        let check = inspect(&bad, id, &source, false, &tools);
        fs::remove_file(damaged).unwrap();
        assert!(!check.ready);

    }
}
