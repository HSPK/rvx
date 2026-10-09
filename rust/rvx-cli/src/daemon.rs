use std::process::Command;

use anyhow::{bail, Context, Result};

use super::DaemonArgs;

pub(super) fn exec_daemon(args: DaemonArgs) -> Result<()> {
    let current = std::env::current_exe().context("locate rvx executable")?;
    #[cfg(windows)]
    let daemon = current.with_file_name("rvxd.exe");
    #[cfg(not(windows))]
    let daemon = current.with_file_name("rvxd");
    if !daemon.is_file() {
        bail!(
            "native rvxd executable is missing beside rvx: {}",
            daemon.display()
        );
    }
    let mut command = Command::new(&daemon);
    if let Some(value) = args.config {
        command.arg("--config").arg(value);
    }
    if let Some(value) = args.data_dir {
        command.arg("--data-dir").arg(value);
    }
    if let Some(value) = args.listen {
        command.arg("--listen").arg(value);
    }
    if let Some(value) = args.ui_dir {
        command.arg("--ui-dir").arg(value);
    }
    if let Some(value) = args.scrape_concurrency {
        command.arg("--scrape-concurrency").arg(value.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        Err(error).with_context(|| format!("launch {}", daemon.display()))
    }
    #[cfg(not(unix))]
    {
        let status = command.status()?;
        if status.success() {
            Ok(())
        } else {
            bail!("rvxd exited with {status}")
        }
    }
}
