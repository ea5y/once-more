//! Own processing children until they finish, including during application exit.
use std::{io::{self, Read}, process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Output, Stdio}, sync::{Arc, Mutex, OnceLock, Weak}, thread, time::Duration};

const SUPERVISOR: &str = "--once-more-processing-child";

/// The pipe stays open only while the desktop process is alive. Unlike an exit
/// callback, EOF is also delivered when the desktop process is killed/crashes.
pub fn command(binary: &std::path::Path) -> Command {
    #[cfg(test)]
    { Command::new(binary) }
    #[cfg(not(test))]
    {
        let mut command = Command::new(std::env::current_exe().expect("application executable"));
        command.arg(SUPERVISOR).arg(binary).stdin(Stdio::piped());
        command
    }
}

pub fn supervisor_entry() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(SUPERVISOR)) { return None; }
    let Some(binary) = args.next() else { return Some(2); };
    let child = match Command::new(binary).args(args).stdin(Stdio::null()).spawn() {
        Ok(child) => Arc::new(Mutex::new(child)),
        Err(error) => { eprintln!("无法启动音频处理：{error}"); return Some(1); }
    };
    let watched = child.clone();
    thread::spawn(move || {
        let mut byte = [0u8; 1];
        loop {
            match io::stdin().read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
        let mut child = watched.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
        let _ = child.wait();
    });
    loop {
        match child.lock().unwrap_or_else(|e| e.into_inner()).try_wait() {
            Ok(Some(status)) => return Some(status.code().unwrap_or(1)),
            Ok(None) => (),
            Err(_) => return Some(1),
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn stop(child: &mut Child) -> io::Result<()> {
    if let Some(pipe) = child.stdin.take() {
        // Let the supervisor reap its worker before it exits itself.
        drop(pipe);
        child.wait().map(|_| ())
    } else { child.kill() }
}

#[derive(Default)]
struct Registry { closing: bool, children: Vec<Weak<Mutex<Child>>> }
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> { REGISTRY.get_or_init(Default::default) }
fn cancelled() -> io::Error { io::Error::new(io::ErrorKind::Interrupted, "应用正在退出，任务可在下次打开后继续") }
pub fn closing() -> bool { registry().lock().unwrap_or_else(|e| e.into_inner()).closing }

impl Registry {
    fn spawn(&mut self, command: &mut Command) -> io::Result<ManagedChild> {
        if self.closing { return Err(cancelled()); }
        let mut child = command.spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let inner = Arc::new(Mutex::new(child));
        self.children.retain(|c| c.strong_count() > 0);
        self.children.push(Arc::downgrade(&inner));
        Ok(ManagedChild { inner, stdout, stderr })
    }
    fn shutdown(&mut self) {
        // Serialize shutdown with spawn: no child can escape registration.
        self.closing = true;
        for child in self.children.drain(..).filter_map(|c| c.upgrade()) {
            let mut child = child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = stop(&mut child);
            let _ = child.wait();
        }
    }
}

pub struct ManagedChild {
    inner: Arc<Mutex<Child>>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}
impl ManagedChild {
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> { self.inner.lock().unwrap_or_else(|e| e.into_inner()).try_wait() }
    pub fn kill(&mut self) -> io::Result<()> { stop(&mut self.inner.lock().unwrap_or_else(|e| e.into_inner())) }
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            // Never hold the child lock during a blocking wait; shutdown needs it.
            if let Some(status) = self.inner.lock().unwrap_or_else(|e| e.into_inner()).try_wait()? { return Ok(status); }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let mut child = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let _ = stop(&mut child);
        let _ = child.wait();
    }
}
pub fn spawn(command: &mut Command) -> io::Result<ManagedChild> { registry().lock().unwrap_or_else(|e| e.into_inner()).spawn(command) }
pub fn status(command: &mut Command) -> io::Result<ExitStatus> { spawn(command)?.wait() }
pub fn output(command: &mut Command) -> io::Result<Output> {
    let mut child = spawn(command.stdout(Stdio::piped()).stderr(Stdio::piped()))?;
    fn drain(mut pipe: impl Read) -> io::Result<Vec<u8>> { let mut bytes = Vec::new(); pipe.read_to_end(&mut bytes)?; Ok(bytes) }
    let stdout = child.stdout.take().expect("stdout configured");
    let stderr = child.stderr.take().expect("stderr configured");
    let out = thread::spawn(move || drain(stdout));
    let error = thread::spawn(move || drain(stderr));
    let status = child.wait();
    if status.is_err() { let _ = child.kill(); }
    let stdout = out.join().map_err(|_| io::Error::other("读取音频处理输出失败"))??;
    let stderr = error.join().map_err(|_| io::Error::other("读取音频处理错误失败"))??;
    Ok(Output { status: status?, stdout, stderr })
}
pub fn shutdown() { registry().lock().unwrap_or_else(|e| e.into_inner()).shutdown(); }

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn shutdown_reaps_children_and_rejects_late_spawn() {
        let mut registry = Registry::default();
        let mut child = registry.spawn(Command::new("/bin/sleep").arg("30")).unwrap();
        let start = std::time::Instant::now();
        registry.shutdown();
        assert!(!child.wait().unwrap().success());
        assert!(start.elapsed() < Duration::from_secs(3));
        assert!(registry.spawn(Command::new("/bin/sleep").arg("30")).is_err());
        registry.shutdown();
    }
    #[test]
    fn output_drains_both_pipes_and_preserves_failure_status() {
        let result = output(Command::new("/bin/sh").args(["-c", "printf hello; printf problem >&2; exit 7"])).unwrap();
        assert_eq!(result.stdout, b"hello");
        assert_eq!(result.stderr, b"problem");
        assert_eq!(result.status.code(), Some(7));
    }
}
