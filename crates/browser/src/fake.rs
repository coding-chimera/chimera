//! Fake driver: an in-memory page model implementing the full driver
//! contract so the seven tools' security and lifecycle tests run without a
//! real browser. It simulates navigation, generation bumping on
//! cross-document navigation, element resolution, typing, evaluation and
//! screenshots as deterministic bytes.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use crate::BrowserError;
use crate::domain::{ElementRef, Snapshot, SnapshotNode, TabRef};
use crate::driver::{
    BrowserDriver, ConnectionSpec, DriverFactory, DriverTab, EvaluateOutcome, NavigationOutcome,
    Origin,
};

/// What one fake page contains.
#[derive(Debug, Clone)]
pub struct FakePage {
    pub url: String,
    pub title: Option<String>,
    pub nodes: Vec<SnapshotNode>,
    pub typed: Vec<(Option<String>, String)>,
    pub clicked: Vec<String>,
    pub evaluated: Vec<String>,
    /// URLs the page redirected through, most recent last.
    pub redirects: Vec<String>,
}

impl FakePage {
    fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            title: None,
            nodes: Vec::new(),
            typed: Vec::new(),
            clicked: Vec::new(),
            evaluated: Vec::new(),
            redirects: Vec::new(),
        }
    }
}

/// Scripted responses for evaluate, keyed by the exact expression text.
#[derive(Debug, Clone, Default)]
pub struct FakeScript {
    pub evaluate_results: HashMap<String, String>,
    /// When set, evaluate returns this for every expression not in the map.
    pub default_evaluate: Option<String>,
    /// When set, navigate to any URL replies with these redirects.
    pub navigate_redirects: Option<Vec<String>>,
}

pub struct FakeDriver {
    pages: StdMutex<HashMap<String, FakePage>>,
    generations: StdMutex<HashMap<String, u64>>,
    script: StdMutex<FakeScript>,
    next_tab: AtomicU64,
    closed: StdMutex<Vec<String>>,
    /// Refuse new tabs beyond this bound (quota simulation).
    pub max_tabs: usize,
    /// Set once by `new` so tabs can hold a shared handle to the same state.
    self_ref: StdMutex<Option<std::sync::Weak<FakeDriver>>>,
}

impl FakeDriver {
    #[must_use]
    pub fn new() -> Arc<Self> {
        let driver = Arc::new(Self {
            pages: StdMutex::new(HashMap::new()),
            generations: StdMutex::new(HashMap::new()),
            script: StdMutex::new(FakeScript::default()),
            next_tab: AtomicU64::new(1),
            closed: StdMutex::new(Vec::new()),
            max_tabs: 8,
            self_ref: StdMutex::new(None),
        });
        *driver.self_ref.lock().unwrap() = Some(Arc::downgrade(&driver));
        driver
    }

    pub fn set_script(&self, script: FakeScript) {
        *self.script.lock().unwrap() = script;
    }

    pub fn closed_tabs(&self) -> Vec<String> {
        self.closed.lock().unwrap().clone()
    }

    pub fn page(&self, raw: &str) -> Option<FakePage> {
        self.pages.lock().unwrap().get(raw).cloned()
    }

    fn generation_of(&self, raw: &str) -> u64 {
        *self.generations.lock().unwrap().get(raw).unwrap_or(&0)
    }
}

impl Default for FakeDriver {
    fn default() -> Self {
        let arc = Self::new();
        let weak = Arc::downgrade(&arc);
        arc.self_ref.lock().unwrap().replace(weak);
        Arc::try_unwrap(arc)
            .ok()
            .expect("fresh fake driver has one owner")
    }
}

pub struct FakeDriverFactory(pub Arc<FakeDriver>);

impl DriverFactory for FakeDriverFactory {
    fn connect(&self, _spec: ConnectionSpec) -> Result<Arc<dyn BrowserDriver>, BrowserError> {
        Ok(self.0.clone())
    }
}

#[async_trait]
impl BrowserDriver for FakeDriver {
    async fn open_tab(&self, url: &str) -> Result<NavigationOutcome, BrowserError> {
        let pages = self.pages.lock().unwrap();
        if pages.len() >= self.max_tabs {
            return Err(BrowserError::Quota(format!(
                "this browser connection already holds {} tabs",
                pages.len()
            )));
        }
        drop(pages);
        let ordinal = self.next_tab.fetch_add(1, Ordering::SeqCst);
        let raw = format!("tab-{ordinal}");
        let mut page = FakePage::new(url);
        let script = self.script.lock().unwrap();
        let mut redirects = Vec::new();
        if let Some(chain) = script.navigate_redirects.as_deref() {
            let mut current = url.to_string();
            for hop in chain {
                redirects.push(hop.clone());
                current = hop.clone();
            }
            page.url = current;
        }
        page.title = Some(format!("fake page {raw}"));
        page.nodes = vec![SnapshotNode {
            reference: format!("e{raw}-1"),
            role: Some("button".into()),
            name: Some("Submit".into()),
            value: None,
            children: Vec::new(),
        }];
        drop(script);
        self.pages.lock().unwrap().insert(raw.clone(), page);
        let generation = self.generation_of(&raw);
        let tab = TabRef::new(
            crate::domain::TabId::new(raw.clone(), generation),
            raw.clone(),
        );
        let origin = Origin::parse(&self.page_url(&raw)).unwrap_or(Origin {
            scheme: "about".into(),
            host: String::new(),
        });
        Ok(NavigationOutcome {
            tab,
            final_url: self.page_url(&raw),
            redirects,
            origin,
            title: Some(format!("fake page {raw}")),
        })
    }

    async fn tab(&self, raw: &str) -> Result<Arc<tokio::sync::Mutex<dyn DriverTab>>, BrowserError> {
        if !self.pages.lock().unwrap().contains_key(raw) {
            return Err(BrowserError::UnknownTab(raw.to_string()));
        }
        let handle: Arc<tokio::sync::Mutex<dyn DriverTab>> =
            Arc::new(tokio::sync::Mutex::new(FakeTab {
                driver: self_as_dyn(self),
                raw: raw.to_string(),
            }));
        Ok(handle)
    }

    fn tab_count(&self) -> usize {
        self.pages.lock().unwrap().len()
    }

    async fn close_all(&self) -> Result<(), BrowserError> {
        let pages = self.pages.lock().unwrap();
        let closed: Vec<String> = pages.keys().cloned().collect();
        drop(pages);
        for raw in closed {
            self.closed.lock().unwrap().push(raw);
        }
        self.pages.lock().unwrap().clear();
        self.generations.lock().unwrap().clear();
        Ok(())
    }
}

fn self_as_dyn(driver: &FakeDriver) -> Arc<FakeDriver> {
    driver
        .self_ref
        .lock()
        .unwrap()
        .as_ref()
        .and_then(std::sync::Weak::upgrade)
        .expect("fake driver tab outlived driver")
}

impl FakeDriver {
    fn page_url(&self, raw: &str) -> String {
        self.pages
            .lock()
            .unwrap()
            .get(raw)
            .map(|page| page.url.clone())
            .unwrap_or_default()
    }
}

pub struct FakeTab {
    driver: Arc<FakeDriver>,
    raw: String,
}

#[async_trait]
impl DriverTab for FakeTab {
    fn reference(&self) -> TabRef {
        TabRef::new(
            crate::domain::TabId::new(self.raw.clone(), self.driver.generation_of(&self.raw)),
            self.raw.clone(),
        )
    }

    fn current_url(&self) -> String {
        self.driver.page_url(&self.raw)
    }

    fn current_origin(&self) -> Origin {
        Origin::parse(&self.current_url()).unwrap_or(Origin {
            scheme: "about".into(),
            host: String::new(),
        })
    }

    fn generation(&self) -> u64 {
        self.driver.generation_of(&self.raw)
    }

    async fn navigate(&mut self, url: &str) -> Result<NavigationOutcome, BrowserError> {
        let script = self.driver.script.lock().unwrap();
        let mut redirects = Vec::new();
        let mut final_url = url.to_string();
        if let Some(chain) = script.navigate_redirects.as_deref() {
            if chain.len() > crate::MAX_REDIRECTS {
                return Err(BrowserError::TooManyRedirects);
            }
            for hop in chain {
                redirects.push(hop.clone());
                final_url = hop.clone();
            }
        }
        drop(script);
        let mut pages = self.driver.pages.lock().unwrap();
        let Some(page) = pages.get_mut(&self.raw) else {
            return Err(BrowserError::UnknownTab(self.raw.clone()));
        };
        let same_document = final_url.split('#').next() == page.url.split('#').next();
        page.url = final_url.clone();
        page.redirects = redirects.clone();
        drop(pages);
        if !same_document {
            let mut generations = self.driver.generations.lock().unwrap();
            let generation = generations.entry(self.raw.clone()).or_insert(0);
            *generation += 1;
        }
        let generation = self.driver.generation_of(&self.raw);
        let origin = Origin::parse(&final_url).unwrap_or(Origin {
            scheme: "about".into(),
            host: String::new(),
        });
        Ok(NavigationOutcome {
            tab: TabRef::new(
                crate::domain::TabId::new(self.raw.clone(), generation),
                self.raw.clone(),
            ),
            final_url,
            redirects,
            origin,
            title: Some(format!("fake page {}", self.raw)),
        })
    }

    async fn snapshot(&self) -> Result<Snapshot, BrowserError> {
        let pages = self.driver.pages.lock().unwrap();
        let Some(page) = pages.get(&self.raw) else {
            return Err(BrowserError::UnknownTab(self.raw.clone()));
        };
        let generation = self.driver.generation_of(&self.raw);
        let nodes = page.nodes.clone();
        let node_count = count_nodes(&nodes);
        Ok(Snapshot {
            tab: self.raw.clone(),
            generation,
            url: page.url.clone(),
            title: page.title.clone(),
            nodes,
            node_count,
        })
    }

    async fn click(&mut self, element: &ElementRef) -> Result<(), BrowserError> {
        let generation = self.driver.generation_of(&self.raw);
        if element.tab != self.raw {
            return Err(BrowserError::StaleElementRef(element.ordinal.to_string()));
        }
        if element.generation != generation {
            return Err(BrowserError::StaleElementRef(element.reference_label()));
        }
        let mut pages = self.driver.pages.lock().unwrap();
        let Some(page) = pages.get_mut(&self.raw) else {
            return Err(BrowserError::UnknownTab(self.raw.clone()));
        };
        let reference = format!("e{}-{}", self.raw, element.ordinal);
        if !node_exists(&page.nodes, &reference) {
            return Err(BrowserError::UnknownElement(element.reference_label()));
        }
        page.clicked.push(reference);
        Ok(())
    }

    async fn type_text(
        &mut self,
        element: Option<&ElementRef>,
        text: &str,
    ) -> Result<(), BrowserError> {
        let generation = self.driver.generation_of(&self.raw);
        if let Some(element) = element {
            if element.tab != self.raw || element.generation != generation {
                return Err(BrowserError::StaleElementRef(element.reference_label()));
            }
        }
        let mut pages = self.driver.pages.lock().unwrap();
        let Some(page) = pages.get_mut(&self.raw) else {
            return Err(BrowserError::UnknownTab(self.raw.clone()));
        };
        let key = element.map(|element| format!("e{}-{}", self.raw, element.ordinal));
        page.typed.push((key, text.to_string()));
        Ok(())
    }

    async fn evaluate(&mut self, expression: &str) -> Result<EvaluateOutcome, BrowserError> {
        let mut pages = self.driver.pages.lock().unwrap();
        let Some(page) = pages.get_mut(&self.raw) else {
            return Err(BrowserError::UnknownTab(self.raw.clone()));
        };
        page.evaluated.push(expression.to_string());
        drop(pages);
        let script = self.driver.script.lock().unwrap();
        let value = script
            .evaluate_results
            .get(expression)
            .cloned()
            .or_else(|| script.default_evaluate.clone())
            .unwrap_or_else(|| "null".to_string());
        let truncated = value.chars().count() > crate::MAX_EVALUATE_CHARS;
        Ok(EvaluateOutcome { value, truncated })
    }

    async fn screenshot(&mut self) -> Result<Vec<u8>, BrowserError> {
        // Deterministic 1x1 PNG.
        Ok(vec![
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H',
            b'D', b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, b'I', b'D', b'A', b'T', 0x78,
            0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
            0x00, 0x00, 0x00, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82,
        ])
    }

    async fn close(&mut self) -> Result<(), BrowserError> {
        let mut pages = self.driver.pages.lock().unwrap();
        if pages.remove(&self.raw).is_some() {
            self.driver.closed.lock().unwrap().push(self.raw.clone());
            self.driver.generations.lock().unwrap().remove(&self.raw);
        }
        Ok(())
    }
}

impl ElementRef {
    #[must_use]
    fn reference_label(&self) -> String {
        format!("{}@{}", self.ordinal, self.generation)
    }
}

fn count_nodes(nodes: &[SnapshotNode]) -> usize {
    nodes
        .iter()
        .map(|node| 1 + count_nodes(&node.children))
        .sum()
}

fn node_exists(nodes: &[SnapshotNode], reference: &str) -> bool {
    nodes
        .iter()
        .any(|node| node.reference == reference || node_exists(&node.children, reference))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_driver_tracks_generation_across_navigations() {
        let driver = FakeDriver::new();
        let outcome = driver.open_tab("https://example.test/first").await.unwrap();
        assert_eq!(outcome.tab.tab_id.generation, 0);
        let tab = driver.tab(&outcome.tab.tab_id.raw).await.unwrap();
        let mut tab = tab.lock().await;
        let second = tab.navigate("https://example.test/second").await.unwrap();
        assert_eq!(second.tab.tab_id.generation, 1);
        let snapshot = tab.snapshot().await.unwrap();
        assert_eq!(snapshot.generation, 1);
    }

    #[tokio::test]
    async fn fake_driver_rejects_stale_element_refs() {
        let driver = FakeDriver::new();
        let outcome = driver.open_tab("https://example.test/").await.unwrap();
        let raw = outcome.tab.tab_id.raw.clone();
        let tab = driver.tab(&raw).await.unwrap();
        let mut tab = tab.lock().await;
        let stale = ElementRef::new(raw.clone(), 0, 1);
        tab.navigate("https://example.test/next").await.unwrap();
        let error = tab.click(&stale).await.unwrap_err();
        assert!(matches!(error, BrowserError::StaleElementRef(_)));
    }
}
