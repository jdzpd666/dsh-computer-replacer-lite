//! Elevated per-user broker for the "desktop replacer".
//!
//! This is a *user-initiated* helper: the human starts it through a UAC prompt
//! (replacer-worker.exe elevated-broker with -Verb RunAs). It is deliberately
//! NOT a Windows service and never requests LocalSystem.
//!
//! Contract:
//! * one named pipe (\\.\pipe\replacer_elevated), framed messages (u32 length + JSON);
//! * strong-typed operations only - ping / observe / invoke / stop. There is no
//!   shell, no arbitrary string command, no process launch, no registry, no file
//!   write API;
//! * observe is a read-only UI Automation capture (elements carry RuntimeIds);
//! * the only action is a UI Automation Invoke on an element addressed by
//!   (HWND, RuntimeId), which the caller must already have observed;
//! * every connection is rejected unless the client process runs under the same
//!   user SID as the broker;
//! * every request is refused while a secure desktop is active (UAC / login /
//!   lock screen): OpenInputDesktop must report "Default";
//! * every accepted/rejected request is appended to a JSONL audit file;
//! * Ctrl+Alt+Shift+Q terminates the broker immediately (global hotkey), and the
//!   pipe "stop" op does the same.
use crate::{context, uia::Uia};
use crate::world::{fault, timestamp, Result};
use serde_json::{json, Value};
use std::{
    ffi::c_void,
    fs::OpenOptions,
    io::Write as _,
    mem::size_of,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE, HLOCAL, E_ACCESSDENIED},
        Security::{
            Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
            GetLengthSid, GetTokenInformation, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TokenElevation, TokenUser,
            TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{ReadFile, WriteFile, PIPE_ACCESS_DUPLEX},
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
                PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
            },
            StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, UOI_NAME},
            Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION},
        },
        UI::{
            Accessibility::{IUIAutomationInvokePattern, UIA_InvokePatternId},
            Input::KeyboardAndMouse::{RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT},
            WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY},
        },
    },
};

const PIPE_NAME: &str = r"\\.\pipe\replacer_elevated";
// Observe frames can carry a full window tree; the capture itself is bounded by the
// worker's MAX_ELEMENTS / MAX_SNAPSHOT_BYTES limits.
const MAX_FRAME: usize = 12 * 1024 * 1024;
const HOTKEY_ID: i32 = 0x5245; // 'RE'
const VK_Q: u32 = 0x51;
static STOPPING: AtomicBool = AtomicBool::new(false);

pub fn run() -> Result<()> {
    if !is_elevated() {
        eprintln!("ELEVATED_BROKER_NOT_ELEVATED: start this command through UAC (Start-Process ... -Verb RunAs)");
        return Err(fault("NOT_ELEVATED", "The broker must be started elevated; nothing is served"));
    }
    let own_sid_text = user_sid(None).ok().and_then(|bytes| sid_to_string(&bytes).ok());
    audit(json!({"event":"start","pid":std::process::id(),"sid":own_sid_text,"ts":timestamp().unwrap_or(0)}));
    start_hotkey_thread();
    println!("ELEVATED_BROKER_READY pipe={PIPE_NAME} pid={} hotkey=Ctrl+Alt+Shift+Q", std::process::id());
    let uia = Uia::new()?;
    while !STOPPING.load(Ordering::SeqCst) {
        let pipe = create_pipe()?;
        match unsafe { connect_pipe(pipe) } {
            Ok(()) => {}
            Err(error) => {
                audit(json!({"event":"connect_failed","error":error.1,"ts":timestamp().unwrap_or(0)}));
                unsafe { let _ = CloseHandle(pipe); }
                continue;
            }
        }
        let mut client_pid = 0u32;
        if unsafe { GetNamedPipeClientProcessId(pipe, &mut client_pid) }.is_err() {
            client_pid = 0;
        }
        let verdict = check_client(client_pid);
        match verdict {
            Ok(()) => {
                audit(json!({"event":"connect","clientPid":client_pid,"ts":timestamp().unwrap_or(0)}));
                let outcome = serve(pipe, client_pid, &uia);
                audit(json!({"event":"disconnect","clientPid":client_pid,"result":outcome.as_ref().map(|_| "ok").unwrap_or("error"),"ts":timestamp().unwrap_or(0)}));
            }
            Err(error) => {
                audit(json!({"event":"reject_client","clientPid":client_pid,"code":error.0,"ts":timestamp().unwrap_or(0)}));
                let _ = write_frame(pipe, &error_json(&error));
            }
        }
        unsafe {
            let _ = DisconnectNamedPipe(pipe);
            let _ = CloseHandle(pipe);
        }
    }
    audit(json!({"event":"stop","reason":"signal","ts":timestamp().unwrap_or(0)}));
    println!("ELEVATED_BROKER_STOPPED");
    Ok(())
}

fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut c_void),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

fn start_hotkey_thread() {
    std::thread::spawn(|| unsafe {
        // Global kill switch. Failure to register (hotkey already taken) is not fatal:
        // the pipe "stop" op still terminates the broker.
        let _ = RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, VK_Q);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            if message.message == WM_HOTKEY {
                STOPPING.store(true, Ordering::SeqCst);
                audit(json!({"event":"stop","reason":"hotkey","ts":timestamp().unwrap_or(0)}));
                std::process::exit(0);
            }
        }
    });
}

fn create_pipe() -> Result<HANDLE> {
    let name: Vec<u16> = PIPE_NAME.encode_utf16().chain(std::iter::once(0)).collect();
    let (attributes, descriptor) = pipe_security()?;
    let pipe = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            MAX_FRAME as u32,
            MAX_FRAME as u32,
            0,
            Some(&attributes),
        )
    };
    unsafe { let _ = LocalFree(Some(HLOCAL(descriptor.0))); }
    if pipe.is_invalid() {
        return Err(fault("PIPE_UNAVAILABLE", format!("CreateNamedPipeW failed: {}", unsafe { GetLastError() }.0)));
    }
    Ok(pipe)
}

/// Explicit DACL for the pipe: SYSTEM and the broker's own user SID.
///
/// A pipe created with a NULL SECURITY_ATTRIBUTES inherits the *default* DACL of the
/// elevated token, which grants the Administrators group. A medium-integrity process of
/// the same user holds that group only as deny-only, so it was refused with
/// ERROR_ACCESS_DENIED. Naming the user SID keeps the same boundary (this user only)
/// while making the pipe reachable from the agent at medium integrity.
fn pipe_security() -> Result<(SECURITY_ATTRIBUTES, PSECURITY_DESCRIPTOR)> {
    let sid = sid_to_string(&user_sid(None)?)?;
    let sddl = format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})");
    let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(wide.as_ptr()), SDDL_REVISION_1, &mut descriptor, None)
            .map_err(|error| fault("PIPE_UNAVAILABLE", format!("ConvertStringSecurityDescriptorToSecurityDescriptorW failed: {error}")))?;
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        ..Default::default()
    };
    Ok((attributes, descriptor))
}

fn sid_to_string(bytes: &[u8]) -> Result<String> {
    unsafe {
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(PSID(bytes.as_ptr() as *mut c_void), &mut text)
            .map_err(|error| fault("CLIENT_DENIED", format!("ConvertSidToStringSidW failed: {error}")))?;
        let rendered = text.to_string().map_err(|error| fault("CLIENT_DENIED", format!("SID text is not valid UTF-16: {error}")));
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut c_void)));
        rendered
    }
}

unsafe fn connect_pipe(pipe: HANDLE) -> Result<()> {
    match ConnectNamedPipe(pipe, None) {
        Ok(()) => Ok(()),
        // ERROR_PIPE_CONNECTED: the client won the race before ConnectNamedPipe.
        Err(error) if error.code().0 == 0x8007_0217u32 as i32 => Ok(()),
        Err(error) => Err(fault("PIPE_UNAVAILABLE", format!("ConnectNamedPipe failed: {error}"))),
    }
}

/// Rejects every client that is not a process of the same user account.
fn check_client(client_pid: u32) -> Result<()> {
    if client_pid == 0 {
        return Err(fault("CLIENT_DENIED", "Client process id is unavailable"));
    }
    let own = user_sid(None)?;
    let client = user_sid(Some(client_pid))?;
    if own == client {
        Ok(())
    } else {
        Err(fault("CLIENT_DENIED", format!("Client process {client_pid} runs under a different user")))
    }
}

fn user_sid(pid: Option<u32>) -> Result<Vec<u8>> {
    unsafe {
        let mut owned_process = HANDLE::default();
        let process = match pid {
            Some(pid) => {
                owned_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                    .map_err(|error| fault("CLIENT_DENIED", format!("OpenProcess({pid}) failed: {error}")))?;
                owned_process
            }
            None => GetCurrentProcess(),
        };
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
        if owned_process != HANDLE::default() {
            let _ = CloseHandle(owned_process);
        }
        opened.map_err(|error| fault("CLIENT_DENIED", format!("OpenProcessToken failed: {error}")))?;
        let mut needed = 0u32;
        // First call only reports the required size (ERROR_INSUFFICIENT_BUFFER).
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return Err(fault("CLIENT_DENIED", "TokenUser size unavailable"));
        }
        let mut buffer = vec![0u8; needed as usize];
        let read = GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut c_void),
            needed,
            &mut needed,
        );
        let _ = CloseHandle(token);
        read.map_err(|error| fault("CLIENT_DENIED", format!("GetTokenInformation failed: {error}")))?;
        let user = std::ptr::read_unaligned(buffer.as_ptr() as *const TOKEN_USER);
        let sid = user.User.Sid;
        let length = GetLengthSid(sid);
        if length == 0 {
            return Err(fault("CLIENT_DENIED", "Empty user SID"));
        }
        Ok(std::slice::from_raw_parts(sid.0 as *const u8, length as usize).to_vec())
    }
}

/// The broker may never act while UAC / login / lock uses a secure desktop.
fn secure_desktop_active() -> Result<bool> {
    unsafe {
        let desktop = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0x0100 /* DESKTOP_SWITCHDESKTOP */))
            .map_err(|error| fault("DESKTOP_UNAVAILABLE", format!("OpenInputDesktop failed: {error}")))?;
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        let read = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr() as *mut c_void),
            (name.len() * size_of::<u16>()) as u32,
            Some(&mut needed),
        );
        let _ = CloseDesktop(desktop);
        read.map_err(|error| fault("DESKTOP_UNAVAILABLE", format!("GetUserObjectInformationW failed: {error}")))?;
        let text = String::from_utf16_lossy(&name);
        let text = text.trim_end_matches('\0');
        Ok(!text.eq_ignore_ascii_case("Default"))
    }
}

fn serve(pipe: HANDLE, client_pid: u32, uia: &Uia) -> Result<()> {
    loop {
        let body = match read_frame(pipe)? {
            Some(body) => body,
            None => return Ok(()),
        };
        let stop = match dispatch(&body, client_pid, uia) {
            Ok((response, stop)) => {
                let _ = write_frame(pipe, &response);
                stop
            }
            Err(error) => {
                let _ = write_frame(pipe, &error_json(&error));
                false
            }
        };
        if stop {
            STOPPING.store(true, Ordering::SeqCst);
            return Ok(());
        }
    }
}

fn dispatch(body: &[u8], client_pid: u32, uia: &Uia) -> Result<(Value, bool)> {
    let request: Value = serde_json::from_slice(body).map_err(|error| fault("INVALID_ARGUMENT", format!("Malformed frame: {error}")))?;
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    match op {
        "ping" => {
            let secure = secure_desktop_active().unwrap_or(true);
            Ok((json!({
                "ok": true,
                "broker": true,
                "pid": std::process::id(),
                "clientPid": client_pid,
                "secureDesktop": secure,
                "ts": timestamp().unwrap_or(0),
            }), false))
        }
        "stop" => {
            audit(json!({"event":"stop","reason":"pipe-op","clientPid":client_pid,"ts":timestamp().unwrap_or(0)}));
            Ok((json!({"ok": true, "stopping": true}), true))
        }
        "observe" => {
            let result = observe(request, uia);
            match &result {
                Ok(value) => audit(json!({"event":"observe","clientPid":client_pid,"hwnd":value.get("hwnd"),"result":"ok","ts":timestamp().unwrap_or(0)})),
                Err(error) => audit(json!({"event":"observe","clientPid":client_pid,"result":"error","code":error.0,"message":error.1,"ts":timestamp().unwrap_or(0)})),
            }
            result.map(|value| (value, false))
        }
        "invoke" => {
            let result = invoke(request, uia);
            match &result {
                Ok(value) => audit(json!({"event":"invoke","clientPid":client_pid,"hwnd":value.get("hwnd"),"result":"ok","ts":timestamp().unwrap_or(0)})),
                Err(error) => audit(json!({"event":"invoke","clientPid":client_pid,"result":"error","code":error.0,"message":error.1,"ts":timestamp().unwrap_or(0)})),
            }
            result.map(|value| (value, false))
        }
        _ => Err(fault("INVALID_ARGUMENT", format!("Unknown op '{op}'; expected ping|observe|invoke|stop"))),
    }
}

fn request_hwnd(request: &Value) -> Result<String> {
    let hwnd = request.get("hwnd").and_then(Value::as_str).unwrap_or("").to_owned();
    if hwnd.is_empty() || hwnd.len() > 20 || !hwnd.bytes().all(|b| b.is_ascii_digit()) {
        return Err(fault("INVALID_ARGUMENT", "hwnd must be a decimal integer string"));
    }
    Ok(hwnd)
}

/// Read-only elevated capture. Needed because a medium-integrity client cannot even see
/// a higher-integrity window in its own UIA tree, so the caller has no RuntimeId to name.
fn observe(request: Value, uia: &Uia) -> Result<Value> {
    let hwnd = request_hwnd(&request)?;
    if secure_desktop_active()? {
        return Err(fault("SECURE_DESKTOP_DENIED", "A secure desktop (UAC/login/lock) is active; nothing was performed"));
    }
    let capture = uia.observe(&hwnd)?;
    Ok(json!({
        "ok": true,
        "elevated": true,
        "pid": std::process::id(),
        "hwnd": capture.hwnd,
        "observedAt": capture.observed_at,
        "elements": capture.elements,
        "focus": capture.focus,
        "complete": true,
        "pullMs": capture.pull_ms,
        "modelMs": capture.model_ms,
    }))
}

fn invoke(request: Value, uia: &Uia) -> Result<Value> {
    let hwnd = request_hwnd(&request)?;
    let runtime_id: Vec<i32> = request
        .get("runtimeId")
        .and_then(Value::as_array)
        .filter(|array| !array.is_empty() && array.len() <= 64)
        .ok_or_else(|| fault("INVALID_ARGUMENT", "runtimeId must be a non-empty array of integers"))?
        .iter()
        .map(|value| value.as_i64().and_then(|v| i32::try_from(v).ok()).ok_or_else(|| fault("INVALID_ARGUMENT", "runtimeId entries must be i32")))
        .collect::<Result<Vec<_>>>()?;
    if secure_desktop_active()? {
        return Err(fault("SECURE_DESKTOP_DENIED", "A secure desktop (UAC/login/lock) is active; nothing was performed"));
    }
    let element = uia.element(&hwnd, &runtime_id)?;
    let pattern = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId).map_err(|error| {
            if error.code() == E_ACCESSDENIED {
                fault("UIPI_BLOCKED", "Target refused the elevated call; nothing was performed")
            } else {
                fault("ELEMENT_NOT_INVOKABLE", format!("Element exposes no Invoke pattern: {error}"))
            }
        })
    }?;
    let outcome = unsafe { pattern.Invoke() };
    std::thread::sleep(std::time::Duration::from_millis(120));
    match outcome {
        Ok(()) => Ok(json!({
            "ok": true,
            "hwnd": hwnd,
            "runtimeId": runtime_id,
            "method": "elevated_uia_invoke",
            "accepted": true,
            "windowAlive": context::alive(&hwnd),
        })),
        Err(error) => {
            let hr = error.code().0;
            Err(fault(
                "INJECTION_UNCERTAIN",
                format!("Invoke returned {error} (HRESULT 0x{hr:08X}); the request may have been delivered, so it is not retried"),
            ))
        }
    }
}

fn error_json(error: &crate::world::Fault) -> Value {
    json!({"ok": false, "code": error.0, "message": error.1})
}

fn read_frame(pipe: HANDLE) -> Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    if !read_exact(pipe, &mut header)? {
        return Ok(None);
    }
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(fault("INVALID_ARGUMENT", format!("Frame length {length} is out of range")));
    }
    let mut body = vec![0u8; length];
    if !read_exact(pipe, &mut body)? {
        return Err(fault("INVALID_ARGUMENT", "Truncated frame"));
    }
    Ok(Some(body))
}

fn read_exact(pipe: HANDLE, buffer: &mut [u8]) -> Result<bool> {
    let mut offset = 0usize;
    while offset < buffer.len() {
        let mut read = 0u32;
        let chunk = &mut buffer[offset..];
        let ok = unsafe { ReadFile(pipe, Some(chunk), Some(&mut read), None) };
        if let Err(error) = ok {
            // ERROR_BROKEN_PIPE (109) / ERROR_PIPE_NOT_CONNECTED (233): clean EOF.
            let code = error.code().0 as u32 & 0xFFFF;
            if code == 109 || code == 233 {
                return Ok(false);
            }
            return Err(fault("PIPE_UNAVAILABLE", format!("ReadFile failed: {error}")));
        }
        if read == 0 {
            return Ok(false);
        }
        offset += read as usize;
    }
    Ok(true)
}

fn write_frame(pipe: HANDLE, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value).map_err(|error| fault("INTERNAL_ERROR", error.to_string()))?;
    if body.len() > MAX_FRAME {
        return Err(fault("INTERNAL_ERROR", "Response frame too large"));
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    let mut offset = 0usize;
    while offset < frame.len() {
        let mut written = 0u32;
        let chunk = &frame[offset..];
        unsafe { WriteFile(pipe, Some(chunk), Some(&mut written), None) }
            .map_err(|error| fault("PIPE_UNAVAILABLE", format!("WriteFile failed: {error}")))?;
        if written == 0 {
            return Err(fault("PIPE_UNAVAILABLE", "WriteFile wrote zero bytes"));
        }
        offset += written as usize;
    }
    Ok(())
}

fn audit(entry: Value) {
    let directory: PathBuf = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("dsh-computer-replacer");
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(directory.join("elevated-broker-audit.jsonl")) {
        let _ = writeln!(file, "{entry}");
    }
}