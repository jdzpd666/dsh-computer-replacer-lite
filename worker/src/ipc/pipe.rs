use std::{fs::OpenOptions, io::{self, BufRead, BufReader, Read, Write}};
use serde_json::json;
const MAX_FRAME: usize = 65536;
fn frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    let size = reader.take((MAX_FRAME + 2) as u64).read_until(10, &mut bytes)?;
    if size == 0 { return Ok(None); }
    if bytes.last() != Some(&10) || bytes.len()-1 > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData,"oversize or truncated frame"));
    }
    bytes.pop();
    Ok(Some(bytes))
}
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args=std::env::args().skip(1);
    let path=args.next().ok_or("missing pipe")?;
    if args.next().is_some() {return Err("unexpected arguments".into());}
    let prefix = format!("{}{}.{}pipe{}replacer-", char::from(92),char::from(92),char::from(92),char::from(92));
    if !path.starts_with(&prefix) {return Err("invalid pipe path".into());}
    // Secret arrives on inherited stdin, never in command-line arguments or logs.
    let mut secret=String::new();
    std::io::stdin().take(257).read_to_string(&mut secret)?;
    if secret.len()!=64 || !secret.bytes().all(|b|b.is_ascii_hexdigit()){return Err("invalid capability".into());}
    let mut pipe=OpenOptions::new().read(true).write(true).open(&path)?;
    writeln!(pipe,"{}",json!({"hello":secret,"pid":std::process::id()}))?;
    pipe.flush()?;
    let mut reader=BufReader::new(pipe.try_clone()?);
    let mut handler=super::handler::Handler::new()?;
    let mut sequence=0;
    while let Some(bytes)=frame(&mut reader)? {
        let request=serde_json::from_slice(&bytes)?;
        sequence+=1;
        let response=handler.handle(request,sequence)?;
        writeln!(pipe,"{response}")?;
        pipe.flush()?;
    }
    Ok(())
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn bounded_lines() {
        let mut reader=std::io::Cursor::new(vec![123,125,10,91,93,10]);
        assert_eq!(frame(&mut reader).unwrap().unwrap(),b"{}");
        assert_eq!(frame(&mut reader).unwrap().unwrap(),b"[]");
        assert!(frame(&mut reader).unwrap().is_none());
        assert!(frame(&mut std::io::Cursor::new(vec![65;MAX_FRAME+2])).is_err());
        assert!(frame(&mut std::io::Cursor::new(b"{}" )).is_err());
    }
}
