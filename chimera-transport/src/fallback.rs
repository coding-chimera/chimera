//! Pre-send connect-layer fallbacks: h2 -> http1 and system proxy -> direct.
//!
//! Both fallbacks exist for one reason: some networks and proxies break one
//! protocol/route and work fine on the other, and discovering that costs a
//! failed connect. They are ONLY ever driven by
//! `reqwest::Error::is_connect()` — TCP connect, TLS handshake, or proxy
//! CONNECT — which is provably before any request bytes are on the wire. A
//! retry after that point would duplicate a POST and a model call, so anything
//! ambiguous is treated as post-send and propagated unchanged.
//!
//! Each fallback remembers its destinations in a small LRU (16) so a network
//! that needs the fallback pays the failed connect once, not once per request.
//! Per-destination caching and the "one remembered decision per origin" shape
//! are adapted from
//! /Volumes/workspace/codex-upstream-main/codex-rs/http-client/src/tls_fallback.rs
//! and .../route_aware_client_pool.rs (Apache-2.0, Copyright OpenAI); the
//! env-proxy detection (`PROXY_ENV_KEYS`, `proxy_env_configured`) is adapted
//! from .../outbound_proxy.rs (Apache-2.0, Copyright OpenAI). One deliberate
//! simplification: redirect traversal is manual in `request.rs` and the
//! fallbacks apply only to the initial hop, so the cache is keyed by the
//! requested (initial) destination only.
use std::collections::{HashSet, VecDeque};
use std::sync::{Mutex, MutexGuard, OnceLock};

use reqwest::Url;

use crate::runtime::{ClientKey, HttpVersion, ProxyMode};

/// Cache ceiling per fallback type; matches the client cache and codex's
/// `MAX_CACHED_RUSTLS_DESTINATIONS`.
pub const DESTINATION_CACHE_CAP: usize = 16;

/// Env-discovered proxy keys reqwest's `system-proxy` honors. An empty value
/// counts as unset, matching reqwest's own env handling.
const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

/// Scheme + host + port. Deliberately excludes the path: a protocol or route
/// decision belongs to the origin, not to one endpoint on it.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Destination {
    scheme: String,
    host: String,
    port: u16,
}

impl Destination {
    pub fn of(url: &Url) -> Option<Self> {
        Some(Self {
            scheme: url.scheme().to_string(),
            host: url.host_str()?.to_string(),
            port: url.port_or_known_default()?,
        })
    }
}

/// Bounded insertion-ordered set: newest at the back, eviction from the front.
struct DestinationCache {
    cap: usize,
    order: VecDeque<Destination>,
    set: HashSet<Destination>,
}

impl DestinationCache {
    fn new(cap: usize) -> Self {
        Self {
            cap,
            order: VecDeque::new(),
            set: HashSet::new(),
        }
    }

    fn contains(&self, destination: &Destination) -> bool {
        self.set.contains(destination)
    }

    fn remember(&mut self, destination: Destination) {
        if !self.set.insert(destination.clone()) {
            return;
        }
        self.order.push_back(destination);
        while self.order.len() > self.cap {
            if let Some(evicted) = self.order.pop_front() {
                self.set.remove(&evicted);
            }
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.set.len()
    }
}

fn cache(
    slot: &'static OnceLock<Mutex<DestinationCache>>,
) -> MutexGuard<'static, DestinationCache> {
    slot.get_or_init(|| Mutex::new(DestinationCache::new(DESTINATION_CACHE_CAP)))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

static PROTOCOL_FALLBACKS: OnceLock<Mutex<DestinationCache>> = OnceLock::new();
static ROUTE_FALLBACKS: OnceLock<Mutex<DestinationCache>> = OnceLock::new();

/// True when this destination already needed the h2 -> http1 fallback.
pub fn protocol_fallback_cached(url: &Url) -> bool {
    Destination::of(url)
        .is_some_and(|destination| cache(&PROTOCOL_FALLBACKS).contains(&destination))
}

/// True when this destination already needed the proxy -> direct fallback.
pub fn route_fallback_cached(url: &Url) -> bool {
    Destination::of(url).is_some_and(|destination| cache(&ROUTE_FALLBACKS).contains(&destination))
}

pub fn remember_protocol_fallback(url: &Url) {
    if let Some(destination) = Destination::of(url) {
        cache(&PROTOCOL_FALLBACKS).remember(destination);
    }
}

pub fn remember_route_fallback(url: &Url) {
    if let Some(destination) = Destination::of(url) {
        cache(&ROUTE_FALLBACKS).remember(destination);
    }
}

/// True when any env proxy is configured, i.e. when a connect failure could be
/// the proxy's fault. reqwest's `system-proxy` also reads OS settings that we
/// cannot enumerate portably; env is the conservative subset we can prove, and
/// a route fallback is only attempted when this returns true.
pub fn proxy_env_configured() -> bool {
    PROXY_ENV_KEYS.iter().any(|key| {
        std::env::var(key)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    })
}

/// Which fallback a retry would use.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FallbackKind {
    Protocol,
    Route,
}

/// Decide the single retry allowed after a connect-layer failure.
///
/// Ordering: a configured proxy is the more common cause of a connect-layer
/// failure, so route fallback is preferred when it is available; otherwise the
/// h2 -> http1 retry. Only ONE retry is ever made per logical request (at most
/// two connect attempts) so an unreachable host cannot multiply the connect
/// timeout by three.
///
/// `None` means "no fallback applies": either both were already tried for this
/// destination, the request is not a candidate (plaintext http cannot need an
/// h2 fallback), or the proxy is pinned by the profile (never bypass it).
pub fn next_attempt(
    key: ClientKey,
    url: &Url,
    proxy_in_play: bool,
) -> Option<(ClientKey, FallbackKind)> {
    if proxy_in_play && key.proxy_mode == ProxyMode::Auto && !route_fallback_cached(url) {
        return Some((
            ClientKey {
                proxy_mode: ProxyMode::Direct,
                ..key
            },
            FallbackKind::Route,
        ));
    }

    // h2 is only negotiated over TLS, so a plaintext request has no protocol
    // fallback to offer.
    if key.http_version == HttpVersion::Auto
        && url.scheme() == "https"
        && !protocol_fallback_cached(url)
    {
        return Some((
            ClientKey {
                http_version: HttpVersion::Http1,
                ..key
            },
            FallbackKind::Protocol,
        ));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test url parses")
    }

    fn key(profile_id: u32, http_version: HttpVersion, proxy_mode: ProxyMode) -> ClientKey {
        ClientKey {
            profile_id,
            http_version,
            proxy_mode,
        }
    }

    #[test]
    fn destination_cache_evicts_oldest_at_capacity() {
        let mut cache = DestinationCache::new(2);
        cache.remember(Destination::of(&url("https://a.test/x")).unwrap());
        cache.remember(Destination::of(&url("https://b.test/x")).unwrap());
        cache.remember(Destination::of(&url("https://c.test/x")).unwrap());

        assert_eq!(cache.len(), 2);
        assert!(!cache.contains(&Destination::of(&url("https://a.test/other")).unwrap()));
        assert!(cache.contains(&Destination::of(&url("https://b.test/y")).unwrap()));
        assert!(cache.contains(&Destination::of(&url("https://c.test/z")).unwrap()));
    }

    #[test]
    fn destination_ignores_path_and_keeps_default_port() {
        let a = Destination::of(&url("https://example.test/a/b")).unwrap();
        let b = Destination::of(&url("https://example.test/c")).unwrap();
        assert_eq!(a, b);
        assert_ne!(Destination::of(&url("http://example.test/")).unwrap(), a);
    }

    #[test]
    fn route_fallback_prefers_proxy_bypass_and_changes_only_the_mode() {
        let target = url("https://route-fallback.test/");
        let key = key(3, HttpVersion::Auto, ProxyMode::Auto);
        let (next, kind) = next_attempt(key, &target, true).expect("route fallback applies");
        assert_eq!(kind, FallbackKind::Route);
        assert_eq!(next.proxy_mode, ProxyMode::Direct);
        assert_eq!(next.http_version, HttpVersion::Auto);
        assert_eq!(next.profile_id, 3);
    }

    #[test]
    fn protocol_fallback_applies_when_no_proxy_is_in_play() {
        let target = url("https://protocol-fallback.test/");
        let key = key(0, HttpVersion::Auto, ProxyMode::Auto);
        let (next, kind) = next_attempt(key, &target, false).expect("protocol fallback applies");
        assert_eq!(kind, FallbackKind::Protocol);
        assert_eq!(next.http_version, HttpVersion::Http1);
        assert_eq!(next.proxy_mode, ProxyMode::Auto);
    }

    #[test]
    fn pinned_proxy_never_falls_back_to_direct() {
        let target = url("https://pinned-proxy.test/");
        let key = key(7, HttpVersion::Auto, ProxyMode::Pinned);
        let (next, kind) =
            next_attempt(key, &target, true).expect("protocol fallback still applies");
        assert_eq!(kind, FallbackKind::Protocol);
        assert_eq!(next.proxy_mode, ProxyMode::Pinned);
        assert_eq!(next.http_version, HttpVersion::Http1);
    }

    #[test]
    fn plaintext_http_has_no_protocol_fallback() {
        let target = url("http://plaintext.test/");
        let key = key(0, HttpVersion::Auto, ProxyMode::Auto);
        assert_eq!(next_attempt(key, &target, false), None);
    }

    #[test]
    fn http1_only_requests_have_no_protocol_fallback() {
        let target = url("https://already-http1.test/");
        let key = key(0, HttpVersion::Http1, ProxyMode::Auto);
        assert_eq!(next_attempt(key, &target, false), None);
    }

    #[test]
    fn remembered_fallbacks_suppress_further_retries_for_that_destination() {
        let target = url("https://remembered-fallback.test/");
        remember_protocol_fallback(&target);
        let key = key(0, HttpVersion::Auto, ProxyMode::Auto);
        assert!(protocol_fallback_cached(&target));
        assert_eq!(next_attempt(key, &target, false), None);
    }
}
