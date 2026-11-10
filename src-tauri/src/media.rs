//! Bounded media byte ranges; large M4A indexes may exceed the asset handler's 1 MB response.
use std::{fs::File, io::{Read, Seek, SeekFrom}};
use tauri::{http::{Request, Response}, Manager};
pub fn respond(app: &tauri::AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    respond_allowed(req, |path| app.asset_protocol_scope().is_allowed(path))
}

fn respond_allowed(req: Request<Vec<u8>>, allowed: impl Fn(&str) -> bool) -> Response<Vec<u8>> {
    let response = || -> Result<Response<Vec<u8>>, Box<dyn std::error::Error>> {
        if req.method()!="GET" && req.method()!="HEAD" { return Ok(Response::builder().status(405).body(vec![])?); }
        let path = percent_encoding::percent_decode(req.uri().path().trim_start_matches('/').as_bytes()).decode_utf8()?;
        if !allowed(path.as_ref()) { return Ok(Response::builder().status(403).body(vec![])?); }
        let mut file=File::open(path.as_ref())?; let len=file.metadata()?.len();
        let mut builder=Response::builder().header("Access-Control-Allow-Origin", "tauri://localhost").header("Accept-Ranges","bytes");
        let mime=match std::path::Path::new(path.as_ref()).extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase().as_str() { "m4a"|"mp4"=>"audio/mp4", "mp3"=>"audio/mpeg", "wav"=>"audio/wav", "aac"=>"audio/aac", "flac"=>"audio/flac", _=>"application/octet-stream" };
        builder=builder.header("Content-Type",mime);
        let (start,length)=if let Some(range)=req.headers().get("range") {
            let ranges=http_range::HttpRange::parse(range.to_str()?,len);
            let ranges=match ranges {Ok(r) if r.len()==1=>r,_=>return Ok(builder.status(416).header("Content-Range",format!("bytes */{len}")).body(vec![])?) };
            let r=&ranges[0]; let length=r.length.min(8*1024*1024);
            builder=builder.status(206).header("Content-Range",format!("bytes {}-{}/{len}",r.start,r.start+length-1));
            (r.start,length)
        } else { (0,len) };
        builder=builder.header("Content-Length",length);
        if req.method()=="HEAD" {return Ok(builder.body(vec![])?);}
        file.seek(SeekFrom::Start(start))?;let mut bytes=Vec::with_capacity(length as usize);file.take(length).read_to_end(&mut bytes)?;
        Ok(builder.body(bytes)?)
    };
    response().unwrap_or_else(|_|Response::builder().status(500).body(vec![]).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_permissions_and_head() {
        let p=std::env::temp_dir().join(format!("{}.m4a",uuid::Uuid::new_v4()));
        let bytes=vec![7u8;2*1024*1024]; std::fs::write(&p,&bytes).unwrap();
        let url=format!("media://localhost/{}",percent_encoding::utf8_percent_encode(p.to_str().unwrap(),percent_encoding::NON_ALPHANUMERIC));
        let request=|range:&str|Request::builder().uri(&url).header("Range",range).body(vec![]).unwrap();
        let r=respond_allowed(request("bytes=0-1622149"), |_|true);
        assert_eq!(r.status(),206);assert_eq!(r.body().len(),1622150);
        assert_eq!(r.headers()["content-range"],"bytes 0-1622149/2097152");
        assert_eq!(respond_allowed(request("bytes=-2"), |_|true).body(),&vec![7,7]);
        assert_eq!(respond_allowed(request("bytes=9999999-"), |_|true).status(),416);
        assert_eq!(respond_allowed(request("bytes=0-1"), |_|false).status(),403);
        let r=respond_allowed(Request::builder().method("HEAD").uri(&url).body(vec![]).unwrap(), |_|true);
        assert!(r.body().is_empty());assert_eq!(r.headers()["content-length"],"2097152");
        std::fs::remove_file(p).unwrap();
    }
}
