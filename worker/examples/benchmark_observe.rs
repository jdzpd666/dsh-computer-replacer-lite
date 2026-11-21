use replacer_worker::{uia::Uia, world::World};
use serde_json::json;

fn targets(args: impl IntoIterator<Item = String>) -> Result<Vec<String>, String> {
    let mut args = args.into_iter().peekable();
    if args.peek().map(String::as_str) == Some("--targets") { args.next(); }
    let values: Vec<String> = args.collect();
    if values.is_empty() { return Err("usage: benchmark_observe [--targets] <decimal HWND> [HWND ...]".into()); }
    values.into_iter().map(|s| {
        if !s.bytes().all(|b| b.is_ascii_digit()) { return Err(format!("Invalid HWND: {s}")); }
        s.parse::<usize>().ok().filter(|n| *n != 0).map(|n| n.to_string())
            .ok_or_else(|| format!("Invalid HWND: {s}"))
    }).collect()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let targets = targets(std::env::args().skip(1))?;
    // A blocked provider still requires the caller to terminate this process.
    let result = std::thread::spawn(move || -> Result<(), String> {
        let mut failed = false;
        for hwnd in targets {
            let run_target = || -> Result<(), String> {
                let uia = Uia::new().map_err(|e| e.to_string())?;
                let mut world = World::new().map_err(|e| e.to_string())?;
                for run in 0..21 {
                    let capture = uia.observe(&hwnd).map_err(|e| e.to_string())?;
                    if run == 0 && capture.elements.len() <= 2 {
                        for element in &capture.elements {
                            eprintln!("{}", json!({
                                "event":"small-tree-diagnostic", "hwnd":hwnd,
                                "id":element["id"], "type":element["type"],
                                "label":element["label"]
                            }));
                        }
                    }
                    let canonical = capture.hwnd.clone();
                    let id = world.insert(capture).map_err(|e| e.to_string())?;
                    let page = world.page(&canonical, &id, 0, None).map_err(|e| e.to_string())?;
                    println!("{}", json!({
                        "run":run, "cold":run==0, "hwnd":canonical,
                        "totalElements":page["totalElements"], "pullMs":page["pullMs"],
                        "modelMs":page["modelMs"], "observeMs":page["observeMs"]
                    }));
                }
                Ok(())
            };
            if let Err(error) = run_target() {
                failed = true;
                eprintln!("{}", json!({"event":"target-error", "hwnd":hwnd, "error":error}));
            }
        }
        if failed { Err("One or more targets failed".into()) } else { Ok(()) }
    }).join().map_err(|_| "UIA thread panicked")?;
    result.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::targets;
    #[test]
    fn parses_targets() {
        assert_eq!(targets(["--targets", "123", "456"].map(String::from)).unwrap(), vec!["123", "456"]);
        assert_eq!(targets(["123".into()]).unwrap(), vec!["123"]);
        for args in [vec![], vec!["--targets"], vec!["0"], vec!["-1"], vec!["abc"]] {
            assert!(targets(args.into_iter().map(String::from)).is_err());
        }
    }
}
