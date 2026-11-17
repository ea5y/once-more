use crate::{err, read_v1_library, write_v1_library, Result};
use rusqlite::Connection;
use std::{fs, path::Path};

// Hold source_operation and the database lock throughout cleanup and publication.
pub fn remove(db: &Connection, id: &str) -> Result<()> {
    let mut library = read_v1_library(db)?.ok_or("片段不存在")?;
    let items = library["items"].as_array_mut().ok_or("片段库格式无效")?;
    let Some(item) = items.iter().find(|i| i["id"] == id) else { return Ok(()) };
    let mut targets = Vec::<String>::new();
    let mut protected = Vec::<String>::new();
    {
        let mut q = db.prepare("SELECT path FROM recordings").map_err(err)?;
        for row in q.query_map([], |r| r.get::<_, String>(0)).map_err(err)? { protected.push(row.map_err(err)?); }
        let mut q = db.prepare("SELECT path,clip_id FROM extraction_files").map_err(err)?;
        for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?))).map_err(err)? {
            let (path,clip) = row.map_err(err)?;
            if clip == id { targets.push(path); } else { protected.push(path); }
        }
    }
    if let Some(path) = item["clipPath"].as_str() { targets.push(path.into()); }
    for other in items.iter() {
        if let Some(path) = other["sourcePath"].as_str() { protected.push(path.into()); }
        if other["id"] != id { if let Some(path) = other["clipPath"].as_str() { protected.push(path.into()); } }
    }
    targets.sort(); targets.dedup();
    for path in &targets { crate::resegment::validate_target(Path::new(path), &protected)?; }
    // Keep the record and registered paths on any failure, allowing idempotent retry.
    for path in &targets {
        match fs::remove_file(path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("提取音频清理失败，片段记录已保留，请重试。".into()),
        }
    }
    items.retain(|i| i["id"] != id);
    let tx = db.unchecked_transaction().map_err(err)?;
    tx.execute("INSERT OR IGNORE INTO retired_clips(id) VALUES(?1)", [id]).map_err(err)?;
    tx.execute("DELETE FROM extraction_files WHERE clip_id=?1", [id]).map_err(err)?;
    write_v1_library(&tx, &library)?;
    tx.commit().map_err(err)
}

#[tauri::command]
pub async fn delete_clip(app: tauri::AppHandle, id: String) -> Result<()> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<crate::Store>();
        let _operation = store.source_operation.lock().map_err(err)?;
        let db = store.connection.lock().map_err(err)?;
        remove(&db, &id)
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_exports_preserves_source_and_prevents_stale_resurrection() {
        let root=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());fs::create_dir(&root).unwrap();
        let source=root.join("source.wav"); let clip=root.join("clip.wav");
        fs::write(&source,b"source").unwrap();fs::write(&clip,b"clip").unwrap();
        let db=Connection::open_in_memory().unwrap();crate::initialize(&db).unwrap();
        let mut library=serde_json::json!({"version":1,"items":[{"id":"one","sourceId":"r","sourcePath":source,"clipPath":clip,"saved":true,"listens":2},{"id":"two","sourceId":"r","sourcePath":source}]});
        write_v1_library(&db,&library).unwrap();remove(&db,"one").unwrap();
        assert!(source.exists());assert!(!clip.exists());
        crate::queue::preserve_new_items(&db,&mut library).unwrap();assert_eq!(library["items"].as_array().unwrap().len(),1);
        remove(&db,"one").unwrap();remove(&db,"two").unwrap();
        assert!(read_v1_library(&db).unwrap().unwrap()["items"].as_array().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_shared_and_invalid_targets_without_losing_records() {
        let root=std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());fs::create_dir(&root).unwrap();
        let path=root.join("source.wav");fs::write(&path,b"safe").unwrap();
        let db=Connection::open_in_memory().unwrap();crate::initialize(&db).unwrap();
        for target in [&path,&root] {
            let library=serde_json::json!({"version":1,"items":[{"id":"one","clipPath":target},{"id":"two","sourcePath":path}]});
            write_v1_library(&db,&library).unwrap();assert!(remove(&db,"one").is_err());
            assert_eq!(read_v1_library(&db).unwrap().unwrap(),library);assert!(path.exists());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
