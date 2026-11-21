mod ipc;
fn main() {
    if std::env::args().nth(1).as_deref() == Some("elevated-broker") {
        if let Err(error) = replacer_worker::elevated_broker::run() {
            eprintln!("ELEVATED_BROKER_STOP: {error}");
            std::process::exit(1);
        }
        return;
    }
    // Worker mode only: the emergency-stop hotkey thread never runs in the
    // elevated-broker branch (the broker is a separate UAC process with no
    // injection surface to stop).
    replacer_worker::panic::spawn_hotkey_thread();
    if let Err(error) = ipc::pipe::run() {
        eprintln!("WORKER_STOP: {error}");
        std::process::exit(1);
    }
}
