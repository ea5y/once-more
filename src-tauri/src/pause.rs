//! Read-only pause preview. No clip or transcription is modified.
use crate::{audio::Tools, err, transcription::Segment, Result, Store};
use serde::Serialize;
use std::{io::Read, path::Path};
use tauri::Manager;
const RATE: usize = 16_000;
const FRAME: usize = 320;
#[derive(Debug)]
pub(crate) struct Cut { pub start: f64, pub end: f64 }
impl Cut { fn midpoint(&self) -> f64 { (self.start + self.end) / 2.0 } }
#[derive(Serialize, Debug)]
pub struct Part { pub start: f64, pub end: f64, pub title: String, pub text: Vec<String>, pub sentences: Vec<Segment> }
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview { pub seconds: f64, pub duration: f64, pub parts: Vec<Part> }
fn validate(seconds: f64) -> Result<()> {
    if !seconds.is_finite() || seconds <= 0.0 { return Err("请输入大于 0 的停顿秒数".into()); }
    Ok(())
}
/// Streaming 20ms RMS frames, -40dBFS; only internal quiet runs create cuts.
pub(crate) fn detect(mut input: impl Read, seconds: f64) -> Result<(f64, Vec<Cut>)> {
    validate(seconds)?;
    let mut bytes = [0u8; FRAME * 4];
    let mut samples = 0usize;
    let mut quiet_start = None;
    let mut cuts = Vec::new();
    loop {
        let mut length = 0;
        while length < bytes.len() {
            match input.read(&mut bytes[length..]) {
                Ok(0) => break,
                Ok(n) => length += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(err(e)),
            }
        }
        if length == 0 { break; }
        if length % 4 != 0 { return Err("音频数据不完整，无法预览".into()); }
        let count = length / 4;
        let mut square = 0.0;
        for chunk in bytes[..length].chunks_exact(4) {
            let value = f32::from_le_bytes(chunk.try_into().unwrap()) as f64;
            if !value.is_finite() { return Err("音频包含无效采样".into()); }
            square += value * value;
        }
        if square / (count as f64) < 0.0001 {
            quiet_start.get_or_insert(samples);
        } else if let Some(start) = quiet_start.take() {
            if start > 0 && ((samples - start) as f64) >= (seconds * RATE as f64).ceil() {
                if cuts.len() >= 9999 { return Err("片段过多，请增大停顿秒数后重试".into()); }
                cuts.push(Cut { start: start as f64 / RATE as f64, end: samples as f64 / RATE as f64 });
            }
        }
        samples += count;
    }
    if samples == 0 { return Err("录音没有可解码内容".into()); }
    // A trailing pause remains part of the last clip, including fully silent recordings.
    Ok((samples as f64 / RATE as f64, cuts))
}
fn assemble(duration: f64, cuts: Vec<Cut>, rows: Vec<Segment>, seconds: f64) -> Result<Preview> {
    let mut edges = vec![0.0]; edges.extend(cuts.iter().map(Cut::midpoint)); edges.push(duration);
    let mut parts: Vec<Part> = edges.windows(2).map(|w| Part { start: w[0], end: w[1], title: String::new(), text: Vec::new(), sentences: Vec::new() }).collect();
    for mut row in rows {
        if !row.start.is_finite() || !row.end.is_finite() || row.start < 0.0 || row.end < row.start || row.end > duration + 1.0 {
            return Err("转写时间与原录音不匹配，无法预览".into());
        }
        // Whole recognition segments belong to their greatest-overlap part, ties go left.
        let mut best = 0; let mut overlap = -1.0;
        for (index, part) in parts.iter().enumerate() {
            let value = (row.end.min(part.end) - row.start.max(part.start)).max(0.0);
            if value > overlap { best = index; overlap = value; }
        }
        if overlap == 0.0 { best = parts.iter().position(|p| row.start < p.end).unwrap_or(parts.len()-1); }
        // Whisper can assign the leading pause (and the preceding utterance tail)
        // to a new sentence. If a sentence spans a detected long pause and ends
        // after speech resumes, attach it to that resumed side, not the silence.
        for (index, cut) in cuts.iter().enumerate() {
            if row.start < cut.midpoint() && row.end > cut.end {
                best = index + 1;
                row.start = row.start.max(cut.end);
            }
        }
        parts[best].text.push(row.text.clone());
        parts[best].sentences.push(row);
    }
    for part in &mut parts {
        part.title = part.text.iter().find(|s| !s.trim().is_empty()).cloned().unwrap_or_else(|| "此段暂无识别文字".into());
    }
    Ok(Preview { seconds, duration, parts })
}
#[tauri::command]
pub async fn preview_pause_segments(app: tauri::AppHandle, id: String, seconds: f64) -> Result<serde_json::Value> {
    validate(seconds)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Store>();
        let _guard = state.waveform_lock.try_lock().map_err(|_| "音频正在处理中，请稍后重试".to_string())?;
        let (path, body, expected): (String, String, String) = {
            let db = state.connection.lock().map_err(err)?;
            db.query_row("SELECT r.path,t.body,t.fingerprint FROM recordings r JOIN local_transcriptions t ON r.id=t.recording_id WHERE r.id=?1 AND t.phase='completed'", [&id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_| "请先完成这条录音的转写".to_string())?
        };
        let source = Path::new(&path);
        let before = crate::transcription::fingerprint(source)?;
        if before != expected { return Err("原录音已变化，与保存的转写不一致，无法预览".into()); }
        let resources = app.path().resource_dir().map_err(err)?;
        let tools = Tools::discover(Some(&resources))?;
        let recorded_at = tools.recorded_at(source)?;
        let (duration, cuts) = tools.pause_boundaries(source, seconds)?;
        if crate::transcription::fingerprint(source)? != before { return Err("预览期间原录音发生变化，请重试".into()); }
        let preview = assemble(duration, cuts, serde_json::from_str(&body).map_err(err)?, seconds)?;
        let aligned: Vec<&Segment> = preview.parts.iter().flat_map(|part| part.sentences.iter()).collect();
        let transcript = serde_json::to_value(aligned).map_err(err)?;
        let mut value = serde_json::to_value(preview).map_err(err)?;
        let db = state.connection.lock().map_err(err)?;
        let (name, modified): (String, u64) = db.query_row("SELECT name,modified FROM recordings WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
        app.asset_protocol_scope().allow_file(source).map_err(err)?;
        value["source"] = serde_json::json!({"id":id,"path":path,"name":name,"modified":modified,"recordedAt":recorded_at});
        value["transcript"] = transcript;
        Ok(value)
    }).await.map_err(err)?
}
/// Explicit text-only repair of saved, unchanged pause ranges. Never changes audio,
/// extraction state, favorites, IDs, or manually edited boundaries.
#[tauri::command]
pub async fn repair_pause_text(app: tauri::AppHandle, id: String, seconds: f64) -> Result<usize> {
    let preview = preview_pause_segments(app.clone(), id.clone(), seconds).await?;
    let state = app.state::<Store>();
    let db = state.connection.lock().map_err(err)?;
    let mut library = crate::read_v1_library(&db)?.ok_or("没有已保存的分段")?;
    let items = library["items"].as_array_mut().ok_or("片段格式无效")?;
    let parts = preview["parts"].as_array().ok_or("预览格式无效")?;
    let indices: Vec<usize> = items.iter().enumerate().filter(|(_,i)| i["sourceId"].as_str()==Some(&id)).map(|(n,_)|n).collect();
    if indices.len()!=parts.len() { return Err("现有分段与预览不同，未修改".into()); }
    for (&index, part) in indices.iter().zip(parts) {
        let item = &items[index];
        let start = item["start"].as_f64().ok_or("起点无效")?;
        let end = start + item["duration"].as_f64().ok_or("时长无效")?;
        if item["pauseSeconds"].as_f64()!=Some(seconds) || (start-part["start"].as_f64().unwrap()).abs()>0.001 || (end-part["end"].as_f64().unwrap()).abs()>0.001 {
            return Err("片段范围已调整，未自动修改文字".into());
        }
    }
    for (&index, part) in indices.iter().zip(parts) {
        items[index]["transcript"] = part["text"].clone();
        items[index]["segmentTranscript"] = part["sentences"].clone();
        items[index]["sourceTranscript"] = preview["transcript"].clone();
    }
    crate::write_v1_library(&db, &library)?;
    Ok(indices.len())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn audio(runs: &[(usize, f32)]) -> Vec<u8> {
        runs.iter().flat_map(|(frames, value)| (0..frames*FRAME).flat_map(move |_| value.to_le_bytes())).collect()
    }
    #[test]
    #[ignore = "explicit read-only text repair preview; requires ONCE_MORE_REPAIR_SOURCE, ROWS and PLAN"]
    fn prepare_text_repair_plan() {
        let source=std::path::PathBuf::from(std::env::var("ONCE_MORE_REPAIR_SOURCE").unwrap());
        let rows=std::path::PathBuf::from(std::env::var("ONCE_MORE_REPAIR_ROWS").unwrap());
        let destination=std::path::PathBuf::from(std::env::var("ONCE_MORE_REPAIR_PLAN").unwrap());
        let before=crate::transcription::fingerprint(&source).unwrap();
        let tools=Tools::discover(Some(std::path::Path::new(env!("CARGO_MANIFEST_DIR")))).unwrap();
        let (duration,cuts)=tools.pause_boundaries(&source,6.0).unwrap();
        let rows:Vec<Segment>=serde_json::from_slice(&std::fs::read(rows).unwrap()).unwrap();
        let count=rows.len();let preview=assemble(duration,cuts,rows,6.0).unwrap();
        assert_eq!(preview.parts.iter().map(|p|p.sentences.len()).sum::<usize>(),count);
        assert_eq!(crate::transcription::fingerprint(&source).unwrap(),before);
        let result=serde_json::json!({"sourceFingerprint":before,"preview":preview});
        std::fs::write(destination,serde_json::to_vec(&result).unwrap()).unwrap();
        println!("Prepared {} parts, preserving {} recognized rows",result["preview"]["parts"].as_array().unwrap().len(),count);
    }
    #[test]
    fn threshold_is_inclusive_and_edges_are_preserved() {
        let bytes = audio(&[(350,0.0),(10,0.2),(299,0.0),(10,0.2),(300,0.0),(10,0.2),(350,0.0)]);
        let (duration,cuts) = detect(bytes.as_slice(),6.0).unwrap();
        assert_eq!(cuts.len(),1); assert_eq!(cuts[0].midpoint(),(350.+10.+299.+10.+150.)*0.02);
        assert!((duration - 26.58).abs() < 1e-9);
        assert_eq!(detect(bytes.as_slice(),5.98).unwrap().1.len(),2);
        assert_eq!(detect(bytes.as_slice(),9.0).unwrap().1.len(),0);
        assert!(detect(bytes.as_slice(),0.0).is_err());
        assert!(detect(bytes.as_slice(),f64::NAN).is_err());
        assert!(detect(&[0u8;3][..],6.0).is_err());
    }
    #[test]
    fn leading_pause_does_not_steal_the_next_sentence() {
        let result = assemble(240.064, vec![Cut{start:48.24,end:56.92}], vec![
            Segment{start:43.76,end:47.12,text:"等雨停了再出门".into()},
            Segment{start:47.12,end:57.78,text:"吃饭的时候".into()},
            Segment{start:57.78,end:62.86,text:"我们聊起了上个月去海边的事情".into()},
        ],6.0).unwrap();
        assert_eq!(result.parts[0].text, vec!["等雨停了再出门"]);
        assert_eq!(result.parts[1].title, "吃饭的时候");
        assert_eq!(result.parts[1].sentences[0].start,56.92);
        assert_eq!(result.parts[0].end,52.58);
        assert_eq!(result.parts.iter().map(|p|p.text.len()).sum::<usize>(),3);
    }
    #[test]
    fn words_appear_once_and_timing_is_contiguous() {
        let result = assemble(20.0, vec![Cut {start:9.0,end:11.5}], vec![Segment{start:8.0,end:11.0,text:"跨界句".into()},Segment{start:12.0,end:15.0,text:"后一句".into()}],6.0).unwrap();
        assert_eq!(result.parts[0].text,vec!["跨界句"]);assert_eq!(result.parts[1].text,vec!["后一句"]);
        assert_eq!(result.parts[0].end,result.parts[1].start);
        let silent = detect(audio(&[(500,0.0)]).as_slice(),6.0).unwrap();
        assert!(silent.1.is_empty());
        assert_eq!(assemble(silent.0,silent.1,vec![],6.0).unwrap().parts.len(),1);
    }
}
