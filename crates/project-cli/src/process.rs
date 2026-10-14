// SPDX-License-Identifier: Apache-2.0
use crate::Result;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

/// No shell, bounded output and lifetime. Callers never include credentials in argv.
pub fn captured(
    command: &mut Command,
    input: Vec<u8>,
    max_output: usize,
    timeout: Duration,
) -> Result<(bool, Vec<u8>)> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Unable to start {}: {error}",
                command.get_program().to_string_lossy()
            )
        })?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let writer = thread::spawn(move || stdin.write_all(&input));
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(max_output as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    // Diagnostics may contain local configuration or credentials. Drain a bounded
    // prefix to avoid blocking, but never return it to the CLI output.
    let errors = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + timeout;
    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), false),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                break (child.wait().ok(), true);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break (None, false);
            }
        }
    };
    let written = writer.join().map_err(|_| "Process input reader failed")?;
    let bytes = reader
        .join()
        .map_err(|_| "Process output reader failed")?
        .map_err(|_| "Process output read failed")?;
    let errors = errors
        .join()
        .map_err(|_| "Process diagnostic reader failed")?
        .map_err(|_| "Process diagnostic read failed")?;
    if timed_out {
        return Err("Process exceeded its time limit".into());
    }
    if bytes.len() > max_output || errors.len() > 16 * 1024 {
        return Err("Process output exceeded its byte limit".into());
    }
    let success = status.is_some_and(|status| status.success());
    if success && written.is_err() {
        return Err("Process did not consume the full input".into());
    }
    Ok((success, bytes))
}
