use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionKind {
    /// System-discovered or user-configured executable launched locally.
    Local { executable: PathBuf },
    /// Explicitly trusted remote devtools websocket endpoint.
    Remote { endpoint: String },
}

/// System Chromium/Chrome discovery. No download, no bundle: only what the
/// host already installed. Lookup order mirrors the documented order in
/// docs/features.toml config: `browser.executable` override first, then
/// platform defaults, then `CHROME_PATH`-style env hints.
pub fn discover_system_browser(override_path: Option<&str>) -> Option<ConnectionKind> {
    if let Some(explicit) = override_path.map(str::trim).filter(|p| !p.is_empty()) {
        return Some(ConnectionKind::Local {
            executable: PathBuf::from(explicit),
        });
    }
    for candidate in default_candidates() {
        if is_executable(&candidate) {
            return Some(ConnectionKind::Local {
                executable: candidate,
            });
        }
    }
    None
}

pub fn default_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    {
        candidates.extend([
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
            "/Applications/Chromium.app/Contents/MacOS/Chromium".into(),
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into(),
        ]);
    }
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    {
        candidates.extend([
            "/usr/bin/chromium".into(),
            "/usr/bin/chromium-browser".into(),
            "/usr/bin/google-chrome".into(),
            "/usr/bin/google-chrome-stable".into(),
            "/snap/bin/chromium".into(),
        ]);
    }
    #[cfg(target_os = "windows")]
    {
        for env in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(env) {
                let base = PathBuf::from(base);
                candidates.push(base.join("Google\\Chrome\\Application\\chrome.exe"));
                candidates.push(base.join("Chromium\\Application\\chrome.exe"));
            }
        }
    }
    if let Some(path) = std::env::var_os("CHROME_PATH") {
        candidates.push(PathBuf::from(path));
    }
    candidates
}

fn is_executable(path: &std::path::Path) -> bool {
    let metadata = std::fs::metadata(path).is_ok();
    if !metadata {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}
