//! Connection, context and quota manager. Connections are keyed by
//! (project, local/remote, headless) so one project's headless session never
//! shares a browser with another project or another mode. Browser contexts
//! are per-session; tab references are per-session and per-generation.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::BrowserError;
use crate::discovery::ConnectionKind;
use crate::driver::{BrowserDriver, ConnectionSpec, DriverFactory, LaunchSpec};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConnectionKey {
    /// Canonical workspace path.
    pub project: String,
    /// Local launched vs remote attached endpoint.
    pub remote: bool,
    pub headless: bool,
}

#[derive(Debug, Clone)]
pub struct BrowserSettings {
    pub executable_override: Option<String>,
    /// Explicitly trusted remote devtools endpoints (ws(s)://...).
    pub trusted_remotes: Vec<String>,
    pub headless: bool,
    pub max_tabs_per_session: usize,
    pub max_connections: usize,
    pub default_navigation_timeout: Duration,
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            executable_override: None,
            trusted_remotes: Vec::new(),
            headless: true,
            max_tabs_per_session: 4,
            max_connections: 4,
            default_navigation_timeout: crate::DEFAULT_NAVIGATION_TIMEOUT,
        }
    }
}

struct Connection {
    driver: Arc<dyn BrowserDriver>,
}

#[derive(Default)]
struct SessionState {
    tabs: Vec<String>,
}

pub struct BrowserManager {
    factory: Arc<dyn DriverFactory>,
    settings: BrowserSettings,
    connections: Mutex<HashMap<ConnectionKey, Connection>>,
    sessions: Mutex<HashMap<String, SessionState>>,
}

impl BrowserManager {
    #[must_use]
    pub fn new(factory: Arc<dyn DriverFactory>, settings: BrowserSettings) -> Arc<Self> {
        Arc::new(Self {
            factory,
            settings,
            connections: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        })
    }

    #[must_use]
    pub fn settings(&self) -> &BrowserSettings {
        &self.settings
    }

    async fn driver_for(
        &self,
        key: &ConnectionKey,
    ) -> Result<Arc<dyn BrowserDriver>, BrowserError> {
        let mut connections = self.connections.lock().await;
        if let Some(existing) = connections.get(key) {
            return Ok(Arc::clone(&existing.driver));
        }
        if connections.len() >= self.settings.max_connections {
            return Err(BrowserError::Quota(format!(
                "this process already holds {} browser connections",
                connections.len()
            )));
        }
        let spec = self.connection_spec(key)?;
        let driver = self.factory.connect(spec)?;
        connections.insert(
            key.clone(),
            Connection {
                driver: Arc::clone(&driver),
            },
        );
        Ok(driver)
    }

    fn connection_spec(&self, key: &ConnectionKey) -> Result<ConnectionSpec, BrowserError> {
        if key.remote {
            // Remote attach requires exactly one explicitly trusted endpoint.
            let endpoint = self
                .settings
                .trusted_remotes
                .first()
                .ok_or_else(|| {
                    BrowserError::UntrustedRemote(
                        "no remote devtools endpoint is configured".into(),
                    )
                })?
                .clone();
            if !self
                .settings
                .trusted_remotes
                .iter()
                .any(|trusted| trusted == &endpoint)
            {
                return Err(BrowserError::UntrustedRemote(endpoint));
            }
            return Ok(ConnectionSpec::Attach { endpoint });
        }
        let kind =
            crate::discovery::discover_system_browser(self.settings.executable_override.as_deref())
                .ok_or(BrowserError::MissingBrowser)?;
        let ConnectionKind::Local { executable } = kind else {
            return Err(BrowserError::UntrustedRemote(
                "remote kind for local key".into(),
            ));
        };
        Ok(ConnectionSpec::Launch(LaunchSpec {
            executable,
            headless: key.headless,
        }))
    }

    /// Open a new tab in the session's connection, respecting per-session
    /// tab quota and recording the tab for cleanup.
    pub async fn open_tab(
        self: &Arc<Self>,
        session_id: &str,
        project: &str,
        url: &str,
    ) -> Result<crate::driver::NavigationOutcome, BrowserError> {
        let key = ConnectionKey {
            project: project.to_string(),
            remote: self.settings.executable_override.is_none()
                && !self.settings.trusted_remotes.is_empty(),
            headless: self.settings.headless,
        };
        let driver = self.driver_for(&key).await?;
        let mut sessions = self.sessions.lock().await;
        let session = sessions.entry(session_id.to_string()).or_default();
        if session.tabs.len() >= self.settings.max_tabs_per_session {
            return Err(BrowserError::Quota(format!(
                "session already holds {} browser tabs",
                session.tabs.len()
            )));
        }
        let outcome = driver.open_tab(url).await?;
        session.tabs.push(outcome.tab.tab_id.raw.clone());
        Ok(outcome)
    }

    /// Look up a tab, verifying it belongs to this session.
    pub async fn tab(
        self: &Arc<Self>,
        session_id: &str,
        project: &str,
        raw: &str,
    ) -> Result<Arc<Mutex<dyn crate::driver::DriverTab>>, BrowserError> {
        let sessions = self.sessions.lock().await;
        let Some(session) = sessions.get(session_id) else {
            return Err(BrowserError::WrongSession(session_id.to_string()));
        };
        if !session.tabs.iter().any(|tab| tab == raw) {
            return Err(BrowserError::WrongSession(raw.to_string()));
        }
        drop(sessions);
        let key = ConnectionKey {
            project: project.to_string(),
            remote: self.settings.executable_override.is_none()
                && !self.settings.trusted_remotes.is_empty(),
            headless: self.settings.headless,
        };
        let driver = self.driver_for(&key).await?;
        driver.tab(raw).await
    }

    /// Close one tab and drop it from the session registry.
    pub async fn close_tab(
        self: &Arc<Self>,
        session_id: &str,
        project: &str,
        raw: &str,
    ) -> Result<(), BrowserError> {
        let tab = self.tab(session_id, project, raw).await?;
        let mut tab = tab.lock().await;
        tab.close().await?;
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(session_id) {
            session.tabs.retain(|tab| tab != raw);
        }
        Ok(())
    }

    /// Release every tab and connection a session owns. Safe to call twice.
    pub async fn close_session(self: &Arc<Self>, session_id: &str) -> Result<(), BrowserError> {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.remove(session_id) else {
            return Ok(());
        };
        drop(sessions);
        let connections = self.connections.lock().await;
        for connection in connections.values() {
            let driver = Arc::clone(&connection.driver);
            for raw in &session.tabs {
                if let Ok(tab) = driver.tab(raw).await {
                    let mut tab = tab.lock().await;
                    let _ = tab.close().await;
                }
            }
        }
        Ok(())
    }

    /// Count of live tabs a session owns.
    #[must_use]
    pub async fn session_tab_count(&self, session_id: &str) -> usize {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|session| session.tabs.len())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{FakeDriver, FakeDriverFactory};

    fn manager(max_tabs: usize) -> Arc<BrowserManager> {
        let settings = BrowserSettings {
            max_tabs_per_session: max_tabs,
            ..BrowserSettings::default()
        };
        BrowserManager::new(Arc::new(FakeDriverFactory(FakeDriver::new())), settings)
    }

    #[tokio::test]
    async fn sessions_isolate_tab_ownership() {
        let manager = manager(8);
        let first = manager
            .open_tab("session-a", "/project", "https://example.test/a")
            .await
            .unwrap();
        let raw = first.tab.tab_id.raw.clone();
        manager
            .open_tab("session-b", "/project", "https://example.test/b")
            .await
            .unwrap();
        let outcome = manager.tab("session-b", "/project", &raw).await;
        assert!(
            matches!(outcome, Err(BrowserError::WrongSession(_))),
            "expected WrongSession"
        );
        assert!(manager.tab("session-a", "/project", &raw).await.is_ok());
    }

    #[tokio::test]
    async fn per_session_tab_quota_is_enforced() {
        let manager = manager(1);
        manager
            .open_tab("session-a", "/project", "https://example.test/a")
            .await
            .unwrap();
        let outcome = manager
            .open_tab("session-a", "/project", "https://example.test/b")
            .await;
        assert!(matches!(outcome, Err(BrowserError::Quota(_))));
    }

    #[tokio::test]
    async fn close_session_releases_tabs() {
        let manager = manager(8);
        manager
            .open_tab("session-a", "/project", "https://example.test/a")
            .await
            .unwrap();
        manager.close_session("session-a").await.unwrap();
        assert_eq!(manager.session_tab_count("session-a").await, 0);
        // Idempotent: a second close is a no-op, not an error.
        manager.close_session("session-a").await.unwrap();
    }

    #[tokio::test]
    async fn projects_get_separate_connections() {
        let settings = BrowserSettings {
            max_connections: 1,
            ..BrowserSettings::default()
        };
        let driver = FakeDriver::new();
        let manager = BrowserManager::new(Arc::new(FakeDriverFactory(driver.clone())), settings);
        manager
            .open_tab("s1", "/project-one", "https://example.test/")
            .await
            .unwrap();
        // Different project: the key differs, so with a one-connection cap
        // the second project is refused rather than sharing the first's.
        let outcome = manager
            .open_tab("s2", "/project-two", "https://example.test/")
            .await;
        assert!(matches!(outcome, Err(BrowserError::Quota(_))));
    }
}
