use crate::{err, Result};
use serde::{Deserialize, Serialize};
use std::{fs, io::{BufReader, Read}, path::{Path, PathBuf}, process::{Command, Stdio}};

pub struct Tools { ffmpeg: PathBuf, ffprobe: PathBuf }

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Waveform { pub duration: f64, pub seconds_per_peak: f64, pub peaks: Vec<f32> }

fn command(binary: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = crate::processes::command(binary);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

impl Tools {
    pub fn discover(resources: Option<&Path>) -> Result<Self> {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let mut directories = Vec::new();
        if let Some(resources) = resources { directories.push(resources.join("binaries")); }
        if cfg!(debug_assertions) { directories.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries")); }
        directories.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
        if cfg!(target_os = "macos") { directories.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]); }
        directories.into_iter().find_map(|directory| {
            let ffmpeg = directory.join(format!("ffmpeg{suffix}"));
            let ffprobe = directory.join(format!("ffprobe{suffix}"));
            (ffmpeg.is_file() && ffprobe.is_file()).then_some(Self { ffmpeg, ffprobe })
        }).ok_or("音频处理工具缺失，请重新安装完整的 Once More 应用。".into())
    }

    /// Embedded timestamp only: filesystem modification dates are not recording dates.
    pub fn recorded_at(&self, source: &Path) -> Result<f64> {
        let output = crate::processes::output(&mut command(&self.ffprobe).args(["-v", "error", "-select_streams", "a:0", "-show_entries", "format_tags=creation_time:stream_tags=creation_time", "-of", "json"]).arg(source)).map_err(err)?;
        if !output.status.success() { return Err("无法读取录音开始时间".into()); }
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(err)?;
        let raw = value["format"]["tags"]["creation_time"].as_str()
            .or_else(|| value["streams"][0]["tags"]["creation_time"].as_str())
            .ok_or("录音缺少可靠的开始时间，无法确定片段日期；请保留原文件。")?;
        let timestamp = chrono::DateTime::parse_from_rfc3339(raw).map_err(|_| "录音开始时间无效".to_string())?;
        Ok(timestamp.timestamp_millis() as f64 / 1000.0)
    }

    pub fn duration(&self, source: &Path) -> Result<f64> {
        if !source.is_file() { return Err("原始录音已移动或不可访问，请恢复原文件后重试。".into()); }
        let result = crate::processes::output(&mut command(&self.ffprobe).args(["-v", "error", "-select_streams", "a:0", "-show_entries", "format=duration:stream=duration", "-of", "json"]).arg(source)).map_err(err)?;
        if !result.status.success() { return Err("无法读取音频信息，文件可能损坏或格式不受支持。".into()); }
        let json: serde_json::Value = serde_json::from_slice(&result.stdout).map_err(err)?;
        let stream = json["streams"].as_array().and_then(|s| s.first()).ok_or("文件中没有可用的音轨")?;
        let duration = stream["duration"].as_str().and_then(|s| s.parse::<f64>().ok())
            .or_else(|| json["format"]["duration"].as_str().and_then(|s| s.parse::<f64>().ok()))
            .ok_or("无法确定音频时长")?;
        if !duration.is_finite() || duration <= 0.0 { return Err("音频时长无效".into()); }
        Ok(duration)
    }

    /// Decode the entire first audio stream; metadata alone cannot prove completeness.
    pub fn verify_clip(&self, source: &Path, expected: f64) -> Result<()> {
        let duration = self.duration(source)?;
        if (duration - expected).abs() > 0.05 { return Err("提取文件时长与最新范围不一致".into()); }
        let mut child = crate::processes::spawn(&mut command(&self.ffmpeg).args(["-v", "error", "-xerror", "-nostdin", "-i"]).arg(source)
            .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"])
            .stdout(Stdio::piped()).stderr(Stdio::null())).map_err(err)?;
        let result = std::io::copy(&mut child.stdout.take().ok_or("无法读取解码结果")?, &mut std::io::sink());
        if result.is_err() { let _ = child.kill(); }
        let status = child.wait().map_err(err)?;
        let seconds = result.map_err(err)? as f64 / 64000.0;
        if !status.success() || (seconds - expected).abs() > 0.05 {
            return Err("提取文件无法完整解码或实际时长不足".into());
        }
        Ok(())
    }

    pub fn waveform(&self, source: &Path) -> Result<Waveform> {
        let duration = self.duration(source)?;
        let rate = 8000.0;
        // At most 200k peaks (~800KB), even for multi-hour recordings.
        let buckets = (duration * 10.0).ceil().clamp(128.0, 200_000.0) as usize;
        let samples_per_peak = (duration * rate / buckets as f64).ceil().max(1.0) as usize;
        let mut child = crate::processes::spawn(&mut command(&self.ffmpeg).args(["-v", "error", "-nostdin", "-i"]).arg(source)
            .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"])
            .stdout(Stdio::piped()).stderr(Stdio::null())).map_err(err)?;
        let result = (|| -> Result<Vec<f32>> {
            let stdout = child.stdout.take().ok_or("无法读取音频流")?;
            let mut reader = BufReader::with_capacity(65_536, stdout);
            let mut peaks = vec![0.0_f32; buckets];
            let mut bytes = [0_u8; 4];
            let mut count = 0_usize;
            loop {
                match reader.read_exact(&mut bytes) {
                    Ok(()) => {
                        let amplitude = f32::from_le_bytes(bytes).abs();
                        if amplitude.is_finite() { let index = (count / samples_per_peak).min(buckets - 1); peaks[index] = peaks[index].max(amplitude.min(1.0)); }
                        count += 1;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(e) => return Err(err(e)),
                }
            }
            if count == 0 { return Err("录音没有可解码的音频内容".into()); }
            Ok(peaks)
        })();
        if result.is_err() { let _ = child.kill(); }
        let status = child.wait().map_err(err)?;
        let peaks = result?;
        if !status.success() { return Err("音频解码失败，未保存不完整波形。".into()); }
        Ok(Waveform { duration, seconds_per_peak: samples_per_peak as f64 / rate, peaks })
    }

    pub fn pause_boundaries(&self, source: &Path, seconds: f64) -> Result<(f64, Vec<crate::pause::Cut>)> {
        if !source.is_file() { return Err("原录音已移动或不可访问，请恢复后重试".into()); }
        let mut child = crate::processes::spawn(&mut command(&self.ffmpeg).args(["-nostdin", "-v", "error", "-i"]).arg(source)
            .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"])
            .stdout(Stdio::piped()).stderr(Stdio::null())).map_err(err)?;
        let result = match child.stdout.take() {
            Some(stdout) => crate::pause::detect(BufReader::new(stdout), seconds),
            None => Err("无法读取音频流".into()),
        };
        if result.is_err() { let _ = child.kill(); }
        let status = child.wait().map_err(err)?;
        let preview = result?;
        if !status.success() { return Err("音频读取未完成，请检查原录音后重试".into()); }
        Ok(preview)
    }

    pub fn prepare_transcription_window(&self, source: &Path, destination: &Path, start: f64, end: f64) -> Result<()> {
        let result = crate::processes::output(&mut command(&self.ffmpeg)
            .args(["-nostdin", "-v", "error", "-n", "-ss", &start.to_string(), "-i"]).arg(source)
            .args(["-t", &(end-start).to_string(), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]).arg(destination)).map_err(err)?;
        if !result.status.success() { return Err("识别小段准备失败，原录音保留".into()); }
        Ok(())
    }

    pub fn prepare_transcription(&self, source: &Path, destination: &Path) -> Result<f64> {
        let duration = self.duration(source)?;
        let result = crate::processes::output(&mut command(&self.ffmpeg).args(["-nostdin", "-v", "error", "-y", "-i"]).arg(source)
            .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]).arg(destination)).map_err(err)?;
        if !result.status.success() { return Err("音频准备失败，请检查原录音后重试".into()); }
        Ok(duration)
    }

    pub fn extract(&self, source: &Path, destination: &Path, start: f64, end: f64) -> Result<()> {
        valid_range(start, end, self.duration(source)?)?;
        let result = crate::processes::output(&mut command(&self.ffmpeg).args(["-nostdin", "-v", "error", "-n", "-ss", &start.to_string(), "-i"])
            .arg(source).args(["-t", &(end-start).to_string(), "-map", "0:a:0", "-vn", "-c:a", "pcm_s24le"]).arg(destination)).map_err(err)?;
        if !result.status.success() { return Err(format!("提取失败：{}", String::from_utf8_lossy(&result.stderr))); }
        let duration = self.duration(destination)?;
        if (duration - (end-start)).abs() > 0.02 { return Err("导出片段时长不完整，原始录音可能已发生变化。".into()); }
        Ok(())
    }
}

pub fn valid_range(start: f64, end: f64, duration: f64) -> Result<()> {
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start || end > duration + 0.001 {
        return Err("片段时间超出原录音范围，请重新选择起止时间。".into());
    }
    Ok(())
}

pub fn fingerprint(source: &Path) -> Result<String> {
    let meta = fs::metadata(source).map_err(|_| "原始录音已移动或不可访问。".to_string())?;
    let modified = meta.modified().map_err(err)?.duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_nanos();
    Ok(format!("v1:{}:{modified}", meta.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(path: &Path) {
        let rate = 8000_u32;
        let samples = rate * 2;
        let mut data = Vec::new();
        data.extend(b"RIFF"); data.extend((36 + samples*2).to_le_bytes()); data.extend(b"WAVEfmt ");
        data.extend(16_u32.to_le_bytes()); data.extend(1_u16.to_le_bytes()); data.extend(1_u16.to_le_bytes());
        data.extend(rate.to_le_bytes()); data.extend((rate*2).to_le_bytes()); data.extend(2_u16.to_le_bytes()); data.extend(16_u16.to_le_bytes());
        data.extend(b"data"); data.extend((samples*2).to_le_bytes());
        for i in 0..samples { let sample = if i < rate { 0 } else { ((i as f64 * 0.17).sin() * 16000.0) as i16 }; data.extend(sample.to_le_bytes()); }
        fs::write(path, data).unwrap();
    }
    #[test]
    fn rejects_out_of_bounds_and_nonfinite_ranges() {
        for (start,end) in [(0.0,3.0),(-1.0,1.0),(1.0,1.0),(1.0,f64::NAN)] { assert!(valid_range(start,end,2.0).is_err()); }
    }
    #[test]
    fn real_audio_waveform_and_exact_export_preserve_original() {
        let tools = Tools::discover(None).expect("Build audio tools with scripts/build-audio-tools.sh before running audio tests");
        let directory = std::env::temp_dir().join(format!("once-more-audio-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("录音 with spaces.wav"); fixture(&source);
        let before = fs::read(&source).unwrap();
        let waveform = tools.waveform(&source).unwrap();
        assert!((waveform.duration-2.0).abs()<0.001);
        assert!(waveform.peaks[0..50].iter().all(|p| *p == 0.0));
        assert!(waveform.peaks.iter().any(|p| *p > 0.4));
        let clip = directory.join("clip.wav");
        tools.extract(&source,&clip,0.25,1.75).unwrap();
        assert!((tools.duration(&clip).unwrap()-1.5).abs()<0.001);
        let clip_before = fs::read(&clip).unwrap();
        assert!(tools.extract(&source,&clip,0.0,1.0).is_err());
        assert_eq!(fs::read(&clip).unwrap(),clip_before);
        assert!(tools.extract(&source,&directory.join("bad.wav"),1.0,5.0).is_err());
        assert_eq!(fs::read(&source).unwrap(),before);
        fs::remove_dir_all(directory).unwrap();
    }
}
