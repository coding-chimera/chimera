#![forbid(unsafe_code)]

pub mod cdp;
pub mod cdp_driver;
pub mod discovery;
pub mod domain;
pub mod driver;
pub mod fake;
pub mod manager;

pub use cdp_driver::CdpDriverFactoryPublic;
pub use domain::{ElementRef, Snapshot, SnapshotNode, TabId, TabRef};
pub use driver::{
    BrowserDriver, ConnectionSpec, DriverFactory, DriverTab, EvaluateOutcome, LaunchSpec,
    NavigationOutcome, Origin,
};
pub use manager::{BrowserManager, BrowserSettings};

use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("no system Chromium/Chrome installation was found")]
    MissingBrowser,
    #[error("failed to launch the browser: {0}")]
    Launch(String),
    #[error("failed to connect to the browser devtools endpoint: {0}")]
    Connect(String),
    #[error("remote CDP endpoint {0} is not trusted for agent use")]
    UntrustedRemote(String),
    #[error("browser connection lost: {0}")]
    Disconnected(String),
    #[error("tab reference {0} is stale: the tab was closed or navigated again")]
    StaleTabRef(String),
    #[error("element reference {0} is stale: take a new snapshot before acting on the page")]
    StaleElementRef(String),
    #[error("tab reference {0} does not exist in this session")]
    UnknownTab(String),
    #[error("element reference {0} does not exist in the current snapshot")]
    UnknownElement(String),
    #[error("navigation to {url} failed: {reason}")]
    NavigationFailed { url: String, reason: String },
    #[error("navigation exceeded the redirect limit")]
    TooManyRedirects,
    #[error("browser quota exceeded: {0}")]
    Quota(String),
    #[error("browser operation timed out")]
    Timeout,
    #[error("tab {0} belongs to a different session")]
    WrongSession(String),
    #[error("page evaluation failed: {0}")]
    Evaluation(String),
    #[error("invalid browser state: {0}")]
    Invalid(String),
}

pub(crate) const MAX_REDIRECTS: usize = 5;
pub(crate) const MAX_EVALUATE_CHARS: usize = 200_000;
pub(crate) const DEFAULT_NAVIGATION_TIMEOUT: Duration = Duration::from_secs(30);
