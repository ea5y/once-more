#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = once_more_lib::supervisor_entry() { std::process::exit(code); }
    once_more_lib::run()
}
