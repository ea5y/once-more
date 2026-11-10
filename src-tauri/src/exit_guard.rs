use crate::{queue, transcription, Store};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct ExitGuard { allowed: AtomicBool, pending: AtomicBool }
pub fn intercept(app: &tauri::AppHandle) -> bool {
    let guard = app.state::<ExitGuard>();
    if guard.allowed.load(Ordering::SeqCst) { return false; }
    let store = app.state::<Store>();
    let busy = store.scanning.load(Ordering::SeqCst)
        || app.state::<queue::Runner>().is_active()
        || app.state::<transcription::Worker>().0.load(Ordering::SeqCst)
        || store.connection.lock().map(|db| db.query_row("SELECT EXISTS(SELECT 1 FROM processing_queue WHERE status IN ('waiting','running'))", [], |r| r.get::<_, bool>(0)).unwrap_or(true)).unwrap_or(true);
    if busy || guard.pending.load(Ordering::SeqCst) {
        guard.pending.store(true, Ordering::SeqCst);
        let _ = app.emit("confirm-processing-exit", ());
        return true;
    }
    false
}
#[tauri::command]
pub fn resolve_processing_exit(app: tauri::AppHandle, confirm: bool) {
    let guard = app.state::<ExitGuard>();
    if !guard.pending.swap(false, Ordering::SeqCst) { return; }
    if confirm { guard.allowed.store(true, Ordering::SeqCst); app.exit(0); }
}
