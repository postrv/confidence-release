// SPDX-License-Identifier: Apache-2.0
#[cfg(unix)]
mod unix {
    use confidence_cli::process::captured;
    use std::{
        process::Command,
        time::{Duration, Instant},
    };

    #[test]
    fn capture_rejects_excess_output_instead_of_truncating_it() {
        let result = captured(
            Command::new("sh").args(["-c", "printf 123456789"]),
            Vec::new(),
            4,
            Duration::from_secs(1),
        );
        assert!(result.unwrap_err().contains("byte limit"));
    }
    #[test]
    fn capture_has_a_real_process_deadline() {
        let start = Instant::now();
        let result = captured(
            Command::new("sleep").arg("5"),
            Vec::new(),
            128,
            Duration::from_millis(40),
        );
        assert!(result.unwrap_err().contains("time limit"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
