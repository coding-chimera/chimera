//! Real CDP WebSocket driver: launches a system Chromium with
//! `--remote-debugging-port`, discovers the devtools endpoint, and drives
//! pages over the devtools WebSocket. All protocol handling is Rust; there
//! is no Node/Playwright sidecar and no bundled browser download.

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::domain::{ElementRef, Snapshot, SnapshotNode, TabRef};
use crate::driver::{
    BrowserDriver, ConnectionSpec, DriverFactory, DriverTab, EvaluateOutcome, LaunchSpec,
    NavigationOutcome, Origin,
};
use crate::{BrowserError, DEFAULT_NAVIGATION_TIMEOUT};

const CDP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const USER_DATA_DIR_PREFIX: &str = "codewhale-browser-";

pub struct CdpDriverFactory;

impl DriverFactory for CdpDriverFactory {
    fn connect(&self, spec: ConnectionSpec) -> Result<Arc<dyn BrowserDriver>, BrowserError> {
        let driver = Arc::new(CdpDriver::create(spec)?);
        *driver
            .self_ref
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(Arc::downgrade(&driver));
        Ok(driver)
    }
}

pub struct CdpDriver {
    state: Mutex<DriverState>,
    next_tab: AtomicU64,
    self_ref: StdMutex<Option<std::sync::Weak<CdpDriver>>>,
}

struct DriverState {
    browser_ws: String,
    process: Option<tokio::process::Child>,
    pages: HashMap<String, Arc<Mutex<CdpPage>>>,
    _user_data_dir: PathBuf,
}

impl CdpDriver {
    pub fn create(spec: ConnectionSpec) -> Result<Self, BrowserError> {
        // A blocking bridge is acceptable only at creation; the driver itself
        // is fully async afterwards.
        let handle = tokio::task::block_in_place(|| tokio::runtime::Handle::try_current())
            .map_err(|error| BrowserError::Launch(error.to_string()))?;
        let state = handle.block_on(Self::start(spec))?;
        Ok(Self {
            state: Mutex::new(state),
            next_tab: AtomicU64::new(1),
            self_ref: StdMutex::new(None),
        })
    }

    async fn start(spec: ConnectionSpec) -> Result<DriverState, BrowserError> {
        match spec {
            ConnectionSpec::Launch(launch) => Self::launch(launch).await,
            ConnectionSpec::Attach { endpoint } => Ok(DriverState {
                browser_ws: endpoint,
                process: None,
                pages: HashMap::new(),
                _user_data_dir: PathBuf::new(),
            }),
        }
    }

    async fn launch(launch: LaunchSpec) -> Result<DriverState, BrowserError> {
        let port = free_port().ok_or_else(|| BrowserError::Launch("no free port".into()))?;
        let user_data_dir = tempfile_dir()?;
        let mut command = tokio::process::Command::new(&launch.executable);
        command
            .arg("--remote-debugging-port")
            .arg(port.to_string())
            .arg(format!("--user-data-dir={}", user_data_dir.display()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-background-networking")
            .arg("--disable-client-side-phishing-detection")
            .arg("--disable-component-update")
            .arg("--disable-default-apps")
            .arg("--disable-hang-monitor")
            .arg("--disable-popup-blocking")
            .arg("--disable-prompt-on-repost")
            .arg("--disable-sync")
            .arg("--disable-translate")
            .arg("--metrics-recording-only")
            .arg("--mute-audio")
            .arg("--remote-allow-origins=*");
        if launch.headless {
            command.arg("--headless=new");
        }
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let process = command.spawn().map_err(|error| {
            BrowserError::Launch(format!("{}: {error}", launch.executable.display()))
        })?;

        // Poll /json/version until the devtools endpoint answers.
        let deadline = tokio::time::Instant::now() + CDP_CONNECT_TIMEOUT;
        let version_url = format!("http://127.0.0.1:{port}/json/version");
        let browser_ws = loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(BrowserError::Connect(format!(
                    "devtools endpoint did not answer within {}s on port {port}",
                    CDP_CONNECT_TIMEOUT.as_secs()
                )));
            }
            match reqwest_shim::get(&version_url).await {
                Ok(Some(body)) => {
                    let parsed: Value = serde_json::from_str(&body).map_err(|error| {
                        BrowserError::Connect(format!("bad /json/version: {error}"))
                    })?;
                    let ws = parsed
                        .get("webSocketDebuggerUrl")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            BrowserError::Connect("no webSocketDebuggerUrl in /json/version".into())
                        })?
                        .to_string();
                    break ws;
                }
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        };
        Ok(DriverState {
            browser_ws,
            process: Some(process),
            pages: HashMap::new(),
            _user_data_dir: user_data_dir,
        })
    }
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

fn tempfile_dir() -> Result<PathBuf, BrowserError> {
    let dir = std::env::temp_dir().join(format!(
        "{USER_DATA_DIR_PREFIX}{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|error| BrowserError::Launch(format!("user-data-dir: {error}")))?;
    Ok(dir)
}

/// Tiny HTTP GET used only for devtools endpoint discovery (loopback).
mod reqwest_shim {
    use super::*;

    pub async fn get(url: &str) -> Result<Option<String>, ()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let parsed = url::Url::parse(url).map_err(|_| ())?;
        let host = parsed.host_str().unwrap_or("127.0.0.1");
        let port = parsed.port().unwrap_or(80);
        let mut stream = TcpStream::connect((host, port)).await.map_err(|_| ())?;
        let path = parsed.path();
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.map_err(|_| ())?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.map_err(|_| ())?;
        let text = String::from_utf8_lossy(&raw).to_string();
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        Ok(Some(body))
    }
}

/// One CDP page session: a dedicated WebSocket to the target with
/// sequential id/response matching and a driver-side event pump.
pub struct CdpPage {
    target_id: String,
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: AtomicU64,
    generation: u64,
    current_url: String,
}

impl CdpPage {
    pub async fn attach(
        browser_ws: &str,
        url: &str,
    ) -> Result<(String, Arc<Mutex<Self>>), BrowserError> {
        // Create the target through the browser endpoint, then attach to it.
        let (target_id, page_ws_url) = create_target(browser_ws, url).await?;
        let (ws, _) = tokio_tungstenite::connect_async(&page_ws_url)
            .await
            .map_err(|error| BrowserError::Connect(format!("page ws {page_ws_url}: {error}")))?;
        let page = Arc::new(Mutex::new(Self {
            target_id: target_id.clone(),
            ws,
            next_id: AtomicU64::new(1),
            generation: 0,
            current_url: url.to_string(),
        }));
        Ok((target_id, page))
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, BrowserError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let message = json!({"id": id, "method": method, "params": params});
        let text = serde_json::to_string(&message)
            .map_err(|error| BrowserError::Invalid(error.to_string()))?;
        self.ws
            .send(Message::Text(text.into()))
            .await
            .map_err(|error| BrowserError::Disconnected(error.to_string()))?;
        let deadline = tokio::time::Instant::now() + DEFAULT_NAVIGATION_TIMEOUT;
        loop {
            let next = tokio::time::timeout_at(deadline, self.ws.next())
                .await
                .map_err(|_| BrowserError::Timeout)?
                .ok_or_else(|| BrowserError::Disconnected("page ws closed".into()))?
                .map_err(|error| BrowserError::Disconnected(error.to_string()))?;
            if !next.is_text() && !next.is_binary() {
                continue;
            }
            let text = next.into_text().unwrap_or_default();
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(BrowserError::Invalid(error.to_string()));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            // Events (frame navigations) update the generation lazily.
            if value.get("method").and_then(Value::as_str) == Some("Page.frameNavigated") {
                let frame = &value["params"]["frame"];
                if frame.get("id").and_then(Value::as_str) == Some(self.target_id.as_str()) {
                    let is_main = frame.get("parentId").is_none();
                    let url = frame.get("url").and_then(Value::as_str).unwrap_or("");
                    if is_main && url != self.current_url && !url.is_empty() {
                        self.current_url = url.to_string();
                        self.generation += 1;
                    }
                }
            }
        }
    }
}

async fn create_target(browser_ws: &str, url: &str) -> Result<(String, String), BrowserError> {
    // The browser-level endpoint is ws://host:port/devtools/browser/<id>;
    // the /json/new HTTP endpoint creates a page target. Chromium requires
    // PUT since M111.
    let parsed = url::Url::parse(browser_ws)
        .map_err(|error| BrowserError::Connect(format!("{browser_ws}: {error}")))?;
    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let port = parsed.port().unwrap_or(80);
    let new_url = format!("http://{host}:{port}/json/new?url={}", urlencode(url));
    let body = http_put(&new_url).await?;
    let parsed_body: Value = serde_json::from_str(&body)
        .map_err(|error| BrowserError::Connect(format!("bad /json/new: {error}")))?;
    let target_id = parsed_body
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| BrowserError::Connect("no target id from /json/new".into()))?
        .to_string();
    let ws_url = parsed_body
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| BrowserError::Connect("no page webSocketDebuggerUrl".into()))?
        .to_string();
    Ok((target_id, ws_url))
}

async fn close_target(browser_ws: &str, target_id: &str) -> Result<(), BrowserError> {
    let parsed = url::Url::parse(browser_ws)
        .map_err(|error| BrowserError::Connect(format!("{browser_ws}: {error}")))?;
    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let port = parsed.port().unwrap_or(80);
    let url = format!("http://{host}:{port}/json/close/{target_id}");
    let _ = http_get(&url).await;
    Ok(())
}

async fn http_put(url: &str) -> Result<String, BrowserError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let parsed = url::Url::parse(url).map_err(|e| BrowserError::Connect(e.to_string()))?;
    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let port = parsed.port().unwrap_or(80);
    let mut stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| BrowserError::Connect(e.to_string()))?;
    let path = format!("{}?{}", parsed.path(), parsed.query().unwrap_or_default());
    let request = format!(
        "PUT {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| BrowserError::Connect(e.to_string()))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .map_err(|e| BrowserError::Connect(e.to_string()))?;
    let text = String::from_utf8_lossy(&raw).to_string();
    Ok(text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default())
}

async fn http_get(url: &str) -> Result<String, BrowserError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let parsed = url::Url::parse(url).map_err(|e| BrowserError::Connect(e.to_string()))?;
    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let port = parsed.port().unwrap_or(80);
    let mut stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| BrowserError::Connect(e.to_string()))?;
    let path = parsed.path();
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| BrowserError::Connect(e.to_string()))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .map_err(|e| BrowserError::Connect(e.to_string()))?;
    let text = String::from_utf8_lossy(&raw).to_string();
    Ok(text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default())
}

fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The driver-side tab handle: owns the shared page session mutex.
pub struct CdpDriverTab {
    driver: Arc<CdpDriver>,
    raw: String,
}

#[async_trait]
impl DriverTab for CdpDriverTab {
    fn reference(&self) -> TabRef {
        TabRef::new(
            crate::domain::TabId::new(self.raw.clone(), self.generation()),
            self.raw.clone(),
        )
    }

    fn current_url(&self) -> String {
        self.driver
            .state
            .try_lock()
            .ok()
            .and_then(|state| {
                state
                    .pages
                    .get(&self.raw)
                    .map(|page| page.current_url.clone())
            })
            .unwrap_or_default()
    }

    fn current_origin(&self) -> Origin {
        Origin::parse(&self.current_url()).unwrap_or(Origin {
            scheme: "about".into(),
            host: String::new(),
        })
    }

    fn generation(&self) -> u64 {
        self.driver
            .state
            .try_lock()
            .ok()
            .and_then(|state| state.pages.get(&self.raw).map(|page| page.generation))
            .unwrap_or(0)
    }

    async fn navigate(&mut self, url: &str) -> Result<NavigationOutcome, BrowserError> {
        let page = self.page().await?;
        let mut page = page.lock().await;
        page.call("Page.navigate", json!({"url": url})).await?;
        let final_url = page.current_url.clone();
        let origin = Origin::parse(&final_url).unwrap_or(Origin {
            scheme: "about".into(),
            host: String::new(),
        });
        let generation = page.generation;
        let title = page
            .call(
                "Runtime.evaluate",
                json!({"expression": "document.title", "returnByValue": true}),
            )
            .await
            .ok()
            .and_then(|result| {
                result
                    .get("result")
                    .and_then(|r| r.get("value"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        Ok(NavigationOutcome {
            tab: TabRef::new(
                crate::domain::TabId::new(self.raw.clone(), generation),
                self.raw.clone(),
            ),
            final_url,
            redirects: Vec::new(),
            origin,
            title,
        })
    }

    async fn snapshot(&self) -> Result<Snapshot, BrowserError> {
        let page = self.page().await?;
        let mut page = page.lock().await;
        let result = page
            .call(
                "Runtime.evaluate",
                json!({"expression": "JSON.stringify(window.__codewhaleSnapshotHook ? window.__codewhaleSnapshotHook() : {nodes: []})", "returnByValue": true}),
            )
            .await?;
        let raw = result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(Value::as_str)
            .unwrap_or("{\"nodes\":[]}");
        let parsed: Value = serde_json::from_str(raw)
            .map_err(|error| BrowserError::Invalid(format!("snapshot: {error}")))?;
        let nodes: Vec<SnapshotNode> = parsed
            .get("nodes")
            .and_then(Value::as_array)
            .map(|nodes| nodes.iter().filter_map(parse_node).collect())
            .unwrap_or_default();
        let url = page.current_url.clone();
        let generation = page.generation;
        let node_count = count_nodes(&nodes);
        Ok(Snapshot {
            tab: self.raw.clone(),
            generation,
            url,
            title: None,
            nodes,
            node_count,
        })
    }

    async fn click(&mut self, element: &ElementRef) -> Result<(), BrowserError> {
        let page = self.page().await?;
        let mut page = page.lock().await;
        if element.generation != page.generation {
            return Err(BrowserError::StaleElementRef(element.ordinal.to_string()));
        }
        let expression = format!(
            "(function() {{ var els = document.querySelectorAll('[data-codewhale-ref]'); \
             var want = 'e{tab}-{ordinal}'; \
             for (var i = 0; i < els.length; i++) {{ \
             if (els[i].getAttribute('data-codewhale-ref') === want) {{ \
             els[i].scrollIntoView(); els[i].click(); return true; }} }} return false; }})()",
            tab = self.raw,
            ordinal = element.ordinal
        );
        let result = page
            .call(
                "Runtime.evaluate",
                json!({"expression": expression, "returnByValue": true}),
            )
            .await?;
        let clicked = result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !clicked {
            return Err(BrowserError::UnknownElement(element.ordinal.to_string()));
        }
        Ok(())
    }

    async fn type_text(
        &mut self,
        element: Option<&ElementRef>,
        text: &str,
    ) -> Result<(), BrowserError> {
        let page = self.page().await?;
        let mut page = page.lock().await;
        if let Some(element) = element
            && element.generation != page.generation
        {
            return Err(BrowserError::StaleElementRef(element.ordinal.to_string()));
        }
        if let Some(element) = element {
            self.click(element).await?;
        }
        page.call("Input.insertText", json!({"text": text})).await?;
        Ok(())
    }

    async fn evaluate(&mut self, expression: &str) -> Result<EvaluateOutcome, BrowserError> {
        let page = self.page().await?;
        let mut page = page.lock().await;
        let result = page
            .call(
                "Runtime.evaluate",
                json!({"expression": expression, "returnByValue": true}),
            )
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(BrowserError::Evaluation(exception.to_string()));
        }
        let value = result
            .get("result")
            .and_then(|r| r.get("value"))
            .map(|value| value.to_string())
            .unwrap_or_else(|| "null".to_string());
        let truncated = value.chars().count() > crate::MAX_EVALUATE_CHARS;
        Ok(EvaluateOutcome { value, truncated })
    }

    async fn screenshot(&mut self) -> Result<Vec<u8>, BrowserError> {
        let page = self.page().await?;
        let mut page = page.lock().await;
        let result = page
            .call("Page.captureScreenshot", json!({"format": "png"}))
            .await?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| BrowserError::Invalid("no screenshot data".into()))?;
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| BrowserError::Invalid(format!("screenshot decode: {error}")))
    }

    async fn close(&mut self) -> Result<(), BrowserError> {
        let browser_ws = {
            let mut state = self.driver.state.lock().await;
            let removed = state.pages.remove(&self.raw).is_some();
            if !removed {
                return Ok(());
            }
            state.browser_ws.clone()
        };
        close_target(&browser_ws, &self.raw).await
    }
}

impl CdpDriverTab {
    async fn page(&self) -> Result<Arc<Mutex<CdpPage>>, BrowserError> {
        let state = self.driver.state.lock().await;
        state
            .pages
            .get(&self.raw)
            .cloned()
            .ok_or_else(|| BrowserError::UnknownTab(self.raw.clone()))
    }
}

fn parse_node(value: &Value) -> Option<SnapshotNode> {
    Some(SnapshotNode {
        reference: value.get("ref")?.as_str()?.to_string(),
        role: value
            .get("role")
            .and_then(Value::as_str)
            .map(str::to_string),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        value: value
            .get("value")
            .and_then(Value::as_str)
            .map(str::to_string),
        children: value
            .get("children")
            .and_then(Value::as_array)
            .map(|children| children.iter().filter_map(parse_node).collect())
            .unwrap_or_default(),
    })
}

fn count_nodes(nodes: &[SnapshotNode]) -> usize {
    nodes
        .iter()
        .map(|node| 1 + count_nodes(&node.children))
        .sum()
}

#[async_trait]
impl BrowserDriver for CdpDriver {
    async fn open_tab(&self, url: &str) -> Result<NavigationOutcome, BrowserError> {
        let browser_ws = {
            let state = self.state.lock().await;
            state.browser_ws.clone()
        };
        let ordinal = self.next_tab.fetch_add(1, Ordering::SeqCst);
        let raw = format!("tab-{ordinal}");
        let (_target_id, page) = CdpPage::attach(&browser_ws, url).await?;
        let mut page_guard = page.lock().await;
        page_guard.call("Page.enable", json!({})).await?;
        page_guard.call("Runtime.enable", json!({})).await?;
        // Inject the ref-stamping hook used by snapshot/click.
        let hook = HOOK_INSTALL.replace("__TAB_PREFIX__", &json!(format!("e{raw}")).to_string());
        page_guard
            .call(
                "Runtime.evaluate",
                json!({"expression": hook, "returnByValue": true}),
            )
            .await?;
        let current_url = page_guard.current_url.clone();
        let origin = Origin::parse(&current_url).unwrap_or(Origin {
            scheme: "about".into(),
            host: String::new(),
        });
        let generation = page_guard.generation;
        drop(page_guard);
        {
            let mut state = self.state.lock().await;
            state.pages.insert(raw.clone(), page);
        }
        Ok(NavigationOutcome {
            tab: TabRef::new(
                crate::domain::TabId::new(raw.clone(), generation),
                raw.clone(),
            ),
            final_url: current_url,
            redirects: Vec::new(),
            origin,
            title: None,
        })
    }

    async fn tab(&self, raw: &str) -> Result<Arc<tokio::sync::Mutex<dyn DriverTab>>, BrowserError> {
        let exists = {
            let state = self.state.lock().await;
            state.pages.contains_key(raw)
        };
        if !exists {
            return Err(BrowserError::UnknownTab(raw.to_string()));
        }
        Ok(Arc::new(tokio::sync::Mutex::new(CdpDriverTab {
            driver: self_arc(self),
            raw: raw.to_string(),
        })))
    }

    fn tab_count(&self) -> usize {
        // Sync snapshot under try_lock; the count is advisory for quotas.
        match self.state.try_lock() {
            Ok(state) => state.pages.len(),
            Err(_) => 0,
        }
    }

    async fn close_all(&self) -> Result<(), BrowserError> {
        let (browser_ws, pages, mut process) = {
            let mut state = self.state.lock().await;
            (
                state.browser_ws.clone(),
                state.pages.drain().map(|(raw, _)| raw).collect::<Vec<_>>(),
                state.process.take(),
            )
        };
        for raw in pages {
            let _ = close_target(&browser_ws, &raw).await;
        }
        if let Some(mut process) = process.take() {
            let _ = process.start_kill();
        }
        Ok(())
    }
}

fn self_arc(driver: &CdpDriver) -> Arc<CdpDriver> {
    driver
        .self_ref
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .as_ref()
        .and_then(std::sync::Weak::upgrade)
        .expect("cdp driver tab outlived driver")
}

impl Drop for CdpDriver {
    fn drop(&mut self) {
        // Best-effort cleanup; close_all is the explicit path.
        if let Ok(mut state) = self.state.try_lock()
            && let Some(mut process) = state.process.take()
        {
            let _ = process.start_kill();
        }
    }
}

/// The snapshot/click hook injected into every page. Stamps
/// `data-codewhale-ref="e<tab>-<ordinal>"` during snapshot, reads it back
/// on click.
const HOOK_INSTALL: &str = r###"(function(tabPrefix) {
  if (window.__codewhaleSnapshotHook) return true;
  window.__codewhaleSnapshotHook = function() {
    var ordinal = 0;
    var nodes = [];
    function walk(node) {
      if (nodes.length >= 400) return;
      ordinal += 1;
      var ref = tabPrefix + '-' + ordinal;
      try { node.setAttribute && node.setAttribute('data-codewhale-ref', ref); } catch (e) {}
      var item = {
        ref: ref,
        role: node.tagName ? node.tagName.toLowerCase() : 'text',
        name: (node.getAttribute && node.getAttribute('aria-label')) || (node.innerText || '').slice(0, 80),
        value: node.value !== undefined ? String(node.value).slice(0, 80) : null,
        children: []
      };
      for (var i = 0; i < node.children.length && i < 50; i++) {
        var child = walk(node.children[i]);
        if (child) item.children.push(child);
      }
      nodes.push(item);
      return item;
    }
    walk(document.body || document.documentElement);
    return {nodes: nodes};
  };
  return true;
})(__TAB_PREFIX__)"###;

pub struct CdpDriverFactoryPublic;

impl CdpDriverFactoryPublic {
    #[must_use]
    pub fn factory() -> Arc<dyn DriverFactory> {
        Arc::new(CdpDriverFactory)
    }
}
