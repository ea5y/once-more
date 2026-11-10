//! A single, pinned local transcription model. Audio never enters this downloader.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs::{self, File}, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::Duration};
use tauri::Manager;
const NAME: &str = "ggml-large-v3-turbo-q5_0.bin";
const URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
const SIZE: u64 = 574_041_195;
const SHA: &str = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
#[derive(Clone, Serialize)]
pub struct Status { phase: String, downloaded: u64, total: u64, error: Option<String> }
pub struct ModelManager { directory: PathBuf, status: Mutex<Status> }
impl ModelManager {
    fn update(&self, phase: &str, downloaded: u64, error: Option<String>) {
        *self.status.lock().unwrap() = Status { phase: phase.into(), downloaded, total: SIZE, error };
    }
    pub fn initialize(directory: PathBuf) -> Arc<Self> {
        let manager = Arc::new(Self { directory, status: Mutex::new(Status { phase: "checking".into(), downloaded: 0, total: SIZE, error: None }) });
        let worker = manager.clone();
        std::thread::spawn(move || {
            let path = worker.directory.join(NAME);
            if !path.exists() { worker.update("missing", 0, None); return; }
            match verify(&path, SIZE, SHA) {
                Ok(()) => worker.update("ready", SIZE, None),
                Err(e) => worker.update("failed", 0, Some(format!("模型检查失败：{e}，请重新下载。"))),
            }
        });
        manager
    }
    pub fn ready_path(&self) -> Result<PathBuf, String> {
        if self.status.lock().map_err(|e| e.to_string())?.phase != "ready" { return Err("请先完成本地转写模型准备".into()); }
        Ok(self.directory.join(NAME))
    }
    fn download(&self) -> Result<(), String> {
        fs::create_dir_all(&self.directory).map_err(|e| format!("无法创建模型目录：{e}"))?;
        let part = self.directory.join(format!("{NAME}.part"));
        let client = reqwest::blocking::Client::builder().https_only(true)
            .connect_timeout(Duration::from_secs(30)).timeout(Duration::from_secs(3600))
            .build().map_err(|e| format!("无法建立下载连接：{e}"))?;
        let mut response = client.get(URL).send().and_then(|r| r.error_for_status())
            .map_err(|_| "下载连接失败，请检查网络后重试。".to_string())?;
        let mut file = File::create(&part).map_err(|e| format!("无法写入模型文件：{e}"))?;
        let mut buffer = [0u8; 64 * 1024];
        let mut downloaded = 0;
        loop {
            let count = response.read(&mut buffer).map_err(|_| "下载中断，请检查网络后重试。".to_string())?;
            if count == 0 { break; }
            downloaded += count as u64;
            if downloaded > SIZE { return Err("下载内容大小不符，请重试。".into()); }
            file.write_all(&buffer[..count]).map_err(|e| format!("模型保存失败：{e}"))?;
            self.update("downloading", downloaded, None);
        }
        file.sync_all().map_err(|e| format!("模型保存失败：{e}"))?;
        drop(file);
        self.update("checking", downloaded, None);
        verify(&part, SIZE, SHA)?;
        fs::rename(&part, self.directory.join(NAME)).map_err(|e| format!("模型安装失败：{e}"))?;
        Ok(())
    }
}
fn verify(path: &Path, size: u64, expected: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != size { return Err("模型文件不完整".into()); }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop { let n = file.read(&mut buffer).map_err(|e| e.to_string())?; if n == 0 { break; } hash.update(&buffer[..n]); }
    if format!("{:x}", hash.finalize()) != expected { return Err("模型校验不通过，请重新下载".into()); }
    Ok(())
}
#[tauri::command]
pub fn get_model_status(app: tauri::AppHandle) -> Status {
    app.state::<Arc<ModelManager>>().status.lock().unwrap().clone()
}
#[tauri::command]
pub fn download_model(app: tauri::AppHandle) -> Result<(), String> {
    let manager = app.state::<Arc<ModelManager>>().inner().clone();
    {
        let mut status = manager.status.lock().unwrap();
        if matches!(status.phase.as_str(), "downloading" | "checking" | "ready") { return Ok(()); }
        status.phase = "downloading".into(); status.downloaded = 0; status.error = None;
    }
    std::thread::spawn(move || match manager.download() {
        Ok(()) => manager.update("ready", SIZE, None),
        Err(e) => { let downloaded = manager.status.lock().unwrap().downloaded; manager.update("failed", downloaded, Some(e)); }
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verification_rejects_truncated_and_same_size_corrupt_files() {
        let path = std::env::temp_dir().join(format!("model-test-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"abc").unwrap();
        let sha = format!("{:x}", Sha256::digest(b"abc"));
        assert!(verify(&path, 3, &sha).is_ok());
        assert!(verify(&path, 4, &sha).is_err());
        fs::write(&path, b"abd").unwrap();
        assert!(verify(&path, 3, &sha).is_err());
        fs::remove_file(&path).unwrap();
        assert!(verify(&path, 3, &sha).is_err());
    }
}
