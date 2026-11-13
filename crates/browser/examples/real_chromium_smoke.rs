// Opt-in real-Chromium smoke over the production CDP driver.
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), String> {
    let chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    let factory = codewhale_browser::driver::production_factory();
    let driver = factory
        .connect(codewhale_browser::driver::ConnectionSpec::Launch(
            codewhale_browser::driver::LaunchSpec {
                executable: chrome.into(),
                headless: true,
            },
        ))
        .map_err(|e| format!("launch: {e}"))?;

    // 1. open
    let opened = driver
        .open_tab("about:blank")
        .await
        .map_err(|e| format!("open: {e}"))?;
    eprintln!(
        "open -> tab {} url {}",
        opened.tab.tab_id.raw, opened.final_url
    );
    let raw = opened.tab.tab_id.raw.clone();

    let tab = driver.tab(&raw).await.map_err(|e| format!("tab: {e}"))?;
    let mut tab = tab.lock().await;

    // 2. snapshot (blank page)
    let snap = tab.snapshot().await.map_err(|e| format!("snapshot: {e}"))?;
    eprintln!("snapshot -> {} nodes, url {}", snap.node_count, snap.url);

    // 3. evaluate
    let outcome = tab
        .evaluate("1 + 1")
        .await
        .map_err(|e| format!("evaluate: {e}"))?;
    eprintln!("evaluate -> {}", outcome.value);

    // 4. screenshot
    let bytes = tab
        .screenshot()
        .await
        .map_err(|e| format!("screenshot: {e}"))?;
    let magic_ok = bytes.len() > 8 && bytes[0] == 0x89 && bytes[1] == b'P';
    eprintln!(
        "screenshot -> {} bytes, png magic: {}",
        bytes.len(),
        magic_ok
    );
    std::fs::write("/tmp/browser_smoke_shot.png", &bytes).map_err(|e| e.to_string())?;

    // 5. navigate (typed path via DriverTab::navigate)
    let nav = tab
        .navigate("about:blank#smoke")
        .await
        .map_err(|e| format!("navigate: {e}"))?;
    eprintln!("navigate -> gen {}", nav.tab.tab_id.generation);

    // 6. type
    tab.type_text(None, "smoke")
        .await
        .map_err(|e| format!("type: {e}"))?;
    eprintln!("type -> ok");

    // 7. close
    drop(tab);
    driver
        .close_all()
        .await
        .map_err(|e| format!("close: {e}"))?;
    eprintln!("close_all -> ok");
    Ok(())
}
