//! Driver abstraction: the engine-facing operations the seven browser tools
//! need, independent of the concrete CDP transport.

use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::Arc;

use crate::BrowserError;
use crate::domain::{ElementRef, Snapshot, TabRef};

/// Origin of a page at one point in time, for the approval model: the
/// scheme+host the next action will act on. `file` origin means local
/// content, which still requires the explicit local-file opt-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub scheme: String,
    pub host: String,
}

impl Origin {
    #[must_use]
    pub fn parse(url: &str) -> Option<Self> {
        let parsed = url::Url::parse(url).ok()?;
        let scheme = parsed.scheme().to_string();
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        Some(Self { scheme, host })
    }

    #[must_use]
    pub fn display(&self) -> String {
        if self.host.is_empty() {
            self.scheme.clone()
        } else {
            format!("{}://{}", self.scheme, self.host)
        }
    }
}

/// How to obtain a browser connection.
#[derive(Debug, Clone)]
pub enum ConnectionSpec {
    Launch(LaunchSpec),
    Attach { endpoint: String },
}

/// Launch parameters for a local system browser.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub executable: PathBuf,
    pub headless: bool,
}

/// Result of opening/navigating a tab.
#[derive(Debug, Clone)]
pub struct NavigationOutcome {
    pub tab: TabRef,
    pub final_url: String,
    pub redirects: Vec<String>,
    pub origin: Origin,
    pub title: Option<String>,
}

/// Result of an evaluate call.
#[derive(Debug, Clone)]
pub struct EvaluateOutcome {
    pub value: String,
    pub truncated: bool,
}

/// One live tab inside the driver, bound to a session and a page generation.
#[async_trait]
pub trait DriverTab: Send + Sync {
    fn reference(&self) -> TabRef;
    fn current_url(&self) -> String;
    fn current_origin(&self) -> Origin;
    fn generation(&self) -> u64;
    async fn navigate(&mut self, url: &str) -> Result<NavigationOutcome, BrowserError>;
    async fn snapshot(&self) -> Result<Snapshot, BrowserError>;
    async fn click(&mut self, element: &ElementRef) -> Result<(), BrowserError>;
    async fn type_text(
        &mut self,
        element: Option<&ElementRef>,
        text: &str,
    ) -> Result<(), BrowserError>;
    async fn evaluate(&mut self, expression: &str) -> Result<EvaluateOutcome, BrowserError>;
    async fn screenshot(&mut self) -> Result<Vec<u8>, BrowserError>;
    async fn close(&mut self) -> Result<(), BrowserError>;
}

/// The browser connection owned by one project+mode pair.
#[async_trait]
pub trait BrowserDriver: Send + Sync {
    async fn open_tab(&self, url: &str) -> Result<NavigationOutcome, BrowserError>;
    async fn tab(&self, raw: &str) -> Result<Arc<tokio::sync::Mutex<dyn DriverTab>>, BrowserError>;
    fn tab_count(&self) -> usize;
    async fn close_all(&self) -> Result<(), BrowserError>;
}

/// Factory seam: tests install a fake; production builds the CDP driver.
pub trait DriverFactory: Send + Sync {
    fn connect(&self, spec: ConnectionSpec) -> Result<Arc<dyn BrowserDriver>, BrowserError>;
}

#[must_use]
pub fn production_factory() -> Arc<dyn DriverFactory> {
    crate::cdp_driver::CdpDriverFactoryPublic::factory()
}
