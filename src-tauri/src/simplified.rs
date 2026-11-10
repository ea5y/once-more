//! macOS ships ICU's Traditional-Simplified transform; no network or text rewriting.
use crate::Result;
#[cfg(target_os = "macos")]
pub fn convert(text: &str) -> Result<String> {
    use std::{ffi::{c_void, CString, CStr}, ptr};
    type CF = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(allocator: CF, text: *const std::ffi::c_char, encoding: u32) -> CF;
        fn CFStringCreateMutableCopy(allocator: CF, capacity: isize, text: CF) -> CF;
        fn CFStringTransform(text: CF, range: *mut c_void, transform: CF, reverse: u8) -> u8;
        fn CFStringGetLength(text: CF) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(text: CF, buffer: *mut std::ffi::c_char, size: isize, encoding: u32) -> u8;
        fn CFRelease(value: CF);
    }
    struct Owned(CF);
    impl Drop for Owned { fn drop(&mut self) { unsafe { CFRelease(self.0) } } }
    const UTF8: u32 = 0x08000100;
    let input = CString::new(text).map_err(|_| "转写内容含无效字符")?;
    let name = CString::new("Traditional-Simplified").unwrap();
    // All CF values are owned and released on every exit. No pointer escapes this function.
    unsafe {
        let original = CFStringCreateWithCString(ptr::null(), input.as_ptr(), UTF8);
        if original.is_null() { return Err("无法读取转写文字".into()); }
        let original = Owned(original);
        let mutable = CFStringCreateMutableCopy(ptr::null(), 0, original.0);
        if mutable.is_null() { return Err("无法准备简体转换".into()); }
        let mutable = Owned(mutable);
        let transform = CFStringCreateWithCString(ptr::null(), name.as_ptr(), UTF8);
        if transform.is_null() { return Err("简体转换不可用".into()); }
        let transform = Owned(transform);
        if CFStringTransform(mutable.0, ptr::null_mut(), transform.0, 0) == 0 { return Err("简体转换失败".into()); }
        let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(mutable.0), UTF8) + 1;
        let mut bytes = vec![0u8; size as usize];
        if CFStringGetCString(mutable.0, bytes.as_mut_ptr().cast(), size, UTF8) == 0 { return Err("简体文字读取失败".into()); }
        CStr::from_ptr(bytes.as_ptr().cast()).to_str().map(str::to_owned).map_err(|e| e.to_string())
    }
}
#[cfg(not(target_os = "macos"))]
pub fn convert(_: &str) -> Result<String> { Err("当前版本仅支持 macOS 本地转写".into()) }
#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn converts_script_preserving_content() {
        assert_eq!(super::convert("這個還能實時翻譯嗎? 字幕:YK 3288 Whisper\n好像挺牛的耶").unwrap(), "这个还能实时翻译吗? 字幕:YK 3288 Whisper\n好像挺牛的耶");
        assert_eq!(super::convert("").unwrap(), "");
    }
}
