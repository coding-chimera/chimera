//! The single process-wide Tokio runtime and the LRU HTTP client cache.
//!
//! Two rules this module exists to enforce:
//!   * exactly one multi-thread runtime per process, sized from the machine's
//!     available parallelism (300+ concurrent streams must not queue behind a
//!     handful of worker threads), and
//!   * a small, bounded set of `reqwest::Client`s — one per
//!     `(tls profile, http version, proxy mode)` key — so requests sharing a
//!     configuration share one connection pool instead of rebuilding pools
//!     (and TLS state) per request.
//!
//! The default key `(0, auto, auto)` reproduces stage-1 behavior exactly:
//! platform trust, env extra roots, ALPN h2, system proxy. Every other key is
//! an explicit profile or a fallback variant of the default.
//!
//! `init()` runs from the napi `module_init` hook and hands the runtime to
//! napi-rs via `create_custom_tokio_runtime`, which is what makes `async fn`
//! exports resolve on this runtime rather than a second one owned by napi.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use reqwest::Client;
use tokio::runtime::Handle;

use crate::profile;

/// Env override, used for load testing (e.g. pin to 4 to see whether the
/// bottleneck is the runtime or the network). Ignored when unset or invalid.
const WORKER_THREADS_ENV: &str = "OPENCODE_RUST_TRANSPORT_WORKER_THREADS";

/// Idle connections kept per host. This is an idle-pool ceiling, not an active
/// connection limit: reqwest does not cap concurrent in-flight connections, so
/// 300 parallel streams to one host are allowed and 512 of them can be reused
/// afterwards without a fresh TCP handshake.
pub const POOL_MAX_IDLE_PER_HOST: usize = 512;

/// Recycle idle sockets eventually so a long-lived process does not hold
/// half-closed connections forever. Deliberately generous; not a request
/// timeout.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// Bounded client cache. 16 is enough for a handful of providers times the
/// three proxy modes and two protocol modes, and small enough that a
/// pathological config cannot grow TLS state without bound.
pub const CLIENT_CACHE_CAP: usize = 16;

static RUNTIME_HANDLE: OnceLock<Handle> = OnceLock::new();

/// Protocol preference for one client.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum HttpVersion {
    /// ALPN negotiates h2 or http/1.1 (https only; plaintext stays HTTP/1.1).
    Auto,
    /// HTTP/1.1 only; ALPN advertises http/1.1 alone.
    Http1,
}

impl HttpVersion {
    /// Parse the ABI string. Absent means `Auto`; anything else is rejected
    /// instead of silently coerced.
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim) {
            None | Some("") | Some("auto") => Ok(HttpVersion::Auto),
            Some("http1") => Ok(HttpVersion::Http1),
            Some(other) => Err(format!(
                "unsupported http_version `{other}`: expected `auto` or `http1`"
            )),
        }
    }

    pub fn http1_only(self) -> bool {
        matches!(self, HttpVersion::Http1)
    }
}

/// Where a client connects through.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ProxyMode {
    /// Env/OS-discovered proxy (reqwest `system-proxy`), bypassable by the
    /// route fallback.
    Auto,
    /// No proxy at all: the route-fallback retry client.
    Direct,
    /// The profile's explicit proxy URL; never falls back to direct.
    Pinned,
}

/// Cache key for one client. `profile_id` identifies the TLS material, so the
/// key stays `Copy` and cheap to hash.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ClientKey {
    pub profile_id: u32,
    pub http_version: HttpVersion,
    pub proxy_mode: ProxyMode,
}

struct ClientCache {
    /// Oldest first; a hit moves the key to the back.
    order: VecDeque<ClientKey>,
    entries: HashMap<ClientKey, Arc<Client>>,
}

impl ClientCache {
    fn new() -> Self {
        Self {
            order: VecDeque::new(),
            entries: HashMap::new(),
        }
    }

    fn touch(&mut self, key: &ClientKey) {
        if let Some(index) = self.order.iter().position(|entry| entry == key) {
            self.order.remove(index);
        }
        self.order.push_back(*key);
    }

    fn insert(&mut self, key: ClientKey, client: Arc<Client>) {
        self.entries.insert(key, client);
        self.touch(&key);
        while self.entries.len() > CLIENT_CACHE_CAP {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            self.entries.remove(&evicted);
        }
    }
}

static CLIENTS: OnceLock<Mutex<ClientCache>> = OnceLock::new();

fn cache() -> MutexGuard<'static, ClientCache> {
    CLIENTS
        .get_or_init(|| Mutex::new(ClientCache::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Worker count for the shared runtime: the env override when it parses to a
/// positive number, otherwise the process's available parallelism.
pub fn worker_threads() -> usize {
    if let Ok(raw) = std::env::var(WORKER_THREADS_ENV) {
        if let Ok(parsed) = raw.trim().parse::<usize>() {
            if parsed > 0 {
                return parsed;
            }
        }
    }
    std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1)
}

/// Build the runtime and install it as napi's async runtime. Called once, from
/// `module_init`. A failure here is reported on stderr and leaves
/// `start_request` returning a clear error instead of panicking.
pub fn init() {
    // TLS first: install the rustls crypto provider (reqwest panics building
    // a rustls client without one) and harvest the env CA roots exactly once,
    // before anything can build a Client.
    crate::tls::init();

    let workers = worker_threads();
    crate::stats::STATS.set_worker_threads(workers);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .thread_name("chimera-transport")
        .enable_all()
        .build();

    match runtime {
        Ok(runtime) => {
            // Keep our own handle: `create_custom_tokio_runtime` takes
            // ownership of the runtime, and `start_request` is called from the
            // JS thread, which is not inside a runtime context.
            let _ = RUNTIME_HANDLE.set(runtime.handle().clone());
            #[cfg(test)]
            {
                // Under `cargo test` the napi `noop` dev-feature stubs
                // create_custom_tokio_runtime and would DROP the runtime,
                // killing every spawned watchdog task (the module_init hook
                // still runs via ctor in the test harness). Leak it instead:
                // the harness process exits after the tests, and the release
                // cdylib never compiles this branch.
                std::mem::forget(runtime);
            }
            #[cfg(not(test))]
            napi::bindgen_prelude::create_custom_tokio_runtime(runtime);
        }
        Err(error) => {
            eprintln!("chimera-transport: failed to build the tokio runtime: {error}");
        }
    }
}

/// Handle for spawning from a non-async (JS) thread.
pub fn handle() -> Option<Handle> {
    RUNTIME_HANDLE.get().cloned()
}

/// The client for one key, built on first use and cached (LRU, cap 16).
///
/// `Client` is an `Arc` internally, so the returned handle is cheap to clone
/// and shares one connection pool with every other holder of the same key.
///
/// TLS trust for profile 0: reqwest's rustls backend defaults to
/// rustls-platform-verifier (the OS trust store); env extra roots are added
/// additively by [`crate::tls::default_trust_config`] — platform trust stays
/// primary and the extra roots are an explicit secondary verifier. If the
/// platform verifier cannot be constructed, the build retries once on bundled
/// webpki roots — logged on stderr, never silent. Explicit profiles carry their
/// own trust and never take that fallback: a profile that cannot build must
/// fail loudly instead of silently changing which roots are trusted.
///
/// Deliberately absent: request timeouts (the TypeScript layer owns
/// deadlines) and retries at this layer (the only retries live in
/// `fallback.rs`, and only for provably pre-send connect failures).
pub fn client_for(key: ClientKey) -> Result<Arc<Client>, String> {
    {
        let mut cache = cache();
        if let Some(client) = cache.entries.get(&key).cloned() {
            cache.touch(&key);
            return Ok(client);
        }
    }

    // Built outside the lock: constructing a client is slow (TLS state, root
    // store) and two concurrent builders for the same key are harmless.
    let client = Arc::new(build_client(key)?);
    let mut cache = cache();
    if let Some(existing) = cache.entries.get(&key).cloned() {
        cache.touch(&key);
        return Ok(existing);
    }
    cache.insert(key, Arc::clone(&client));
    Ok(client)
}

fn build_client(key: ClientKey) -> Result<Client, String> {
    let profile = profile::get(key.profile_id)
        .ok_or_else(|| format!("unknown tls profile id {}", key.profile_id))?;

    // A profile with a pinned proxy must always be built in Pinned mode;
    // anything else would silently bypass the operator's proxy.
    if profile.has_pinned_proxy() && key.proxy_mode != ProxyMode::Pinned {
        return Err(format!(
            "tls profile {} pins a proxy; it cannot be built in `{:?}` proxy mode",
            key.profile_id, key.proxy_mode
        ));
    }

    let builder = transport_builder(key)?;

    if key.profile_id == 0 {
        if !crate::tls::has_extra_roots() {
            return builder
                .build()
                .map_err(|error| format!("failed to build the http client: {error}"));
        }
        // Env extra roots are additive: OS platform trust stays primary and a
        // verifier over the extra roots alone is the fallback (see `tls.rs`).
        return match crate::tls::default_trust_config(key.http_version.http1_only()) {
            Ok(config) => builder
                .use_preconfigured_tls(config)
                .build()
                .map_err(|error| format!("failed to build the http client: {error}")),
            Err(error) => {
                // Platform verifier construction failed (unreadable OS trust
                // store, locked-down container). The fallback config carries
                // the env extra roots and an explicit ALPN list.
                eprintln!(
                    "chimera-transport: platform TLS verifier unavailable ({error}); \
                     falling back to bundled webpki roots"
                );
                transport_builder(key)?
                    .use_preconfigured_tls(crate::tls::webpki_fallback_config(
                        key.http_version.http1_only(),
                    ))
                    .build()
                    .map_err(|error| format!("failed to build the http client: {error}"))
            }
        };
    }

    // Every explicit profile is built from an explicit rustls config so OS trust
    // stays primary while a pinned CA / env extra roots are added additively.
    // reqwest's `tls_certs_merge` does wire extra roots into the platform
    // verifier, but macOS SecTrust policy can still reject the resulting chain
    // (e.g. the 398-day TLS leaf validity limit), so `tls.rs` adds a fallback
    // verifier over the extra roots alone. Client identity (mTLS) is applied by
    // the same helper.
    let config = crate::tls::preconfigured_profile_config(&profile, key.http_version.http1_only())?;
    builder
        .use_preconfigured_tls(config)
        .build()
        .map_err(|error| format!("failed to build the http client: {error}"))
}

/// Transport tuning shared by every client: connection reuse, redirects,
/// compression, protocol preference and proxy mode.
fn transport_builder(key: ClientKey) -> Result<reqwest::ClientBuilder, String> {
    let builder = base_builder();
    let builder = if key.http_version.http1_only() {
        builder.http1_only()
    } else {
        builder
    };
    match key.proxy_mode {
        ProxyMode::Auto => Ok(builder),
        ProxyMode::Direct => Ok(builder.no_proxy()),
        ProxyMode::Pinned => {
            let profile = profile::get(key.profile_id)
                .ok_or_else(|| format!("unknown tls profile id {}", key.profile_id))?;
            let url = profile
                .proxy
                .as_deref()
                .ok_or_else(|| "pinned proxy mode without a proxy url".to_string())?;
            // `ClientBuilder::proxy` also disables system-proxy discovery, so
            // the pinned proxy is the only route.
            let proxy = reqwest::Proxy::all(url)
                .map_err(|error| format!("invalid proxy url `{url}`: {error}"))?;
            Ok(builder.proxy(proxy))
        }
    }
}

fn base_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .tcp_nodelay(true)
        .pool_max_idle_per_host(POOL_MAX_IDLE_PER_HOST)
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
        // Redirects are followed MANUALLY by `request.rs`, never by reqwest:
        // automatic following makes a connect failure on a later hop
        // indistinguishable from a pre-send failure on the first one, which
        // would let the fallback replay an already-accepted POST.
        .redirect(reqwest::redirect::Policy::none())
        .gzip(true)
        .brotli(true)
        .deflate(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stage-1 behavior: platform trust, ALPN h2, system proxy. Production
    /// keys always come from `StartSpec`; tests need a canonical default.
    const DEFAULT_KEY: ClientKey = ClientKey {
        profile_id: 0,
        http_version: HttpVersion::Auto,
        proxy_mode: ProxyMode::Auto,
    };

    fn key(profile_id: u32, http_version: HttpVersion, proxy_mode: ProxyMode) -> ClientKey {
        ClientKey {
            profile_id,
            http_version,
            proxy_mode,
        }
    }

    #[test]
    fn http_version_parsing_accepts_only_auto_and_http1() {
        assert_eq!(HttpVersion::parse(None), Ok(HttpVersion::Auto));
        assert_eq!(HttpVersion::parse(Some("")), Ok(HttpVersion::Auto));
        assert_eq!(HttpVersion::parse(Some("auto")), Ok(HttpVersion::Auto));
        assert_eq!(HttpVersion::parse(Some("http1")), Ok(HttpVersion::Http1));
        assert!(HttpVersion::parse(Some("http2")).is_err());
        assert!(HttpVersion::parse(Some("HTTP1")).is_err());
    }

    #[test]
    fn client_cache_evicts_least_recently_used_at_capacity() {
        let mut cache = ClientCache::new();
        // Distinct synthetic keys; the value is one shared opaque client.
        let keys: Vec<ClientKey> = (0..CLIENT_CACHE_CAP as u32)
            .map(|id| key(id, HttpVersion::Auto, ProxyMode::Auto))
            .collect();
        let client = Arc::new(
            transport_builder(DEFAULT_KEY)
                .expect("builder")
                .build()
                .expect("client builds"),
        );
        for key in &keys {
            cache.insert(*key, Arc::clone(&client));
        }
        assert_eq!(cache.entries.len(), CLIENT_CACHE_CAP);

        // Touch the oldest, then insert one more: the second-oldest must go.
        cache.touch(&keys[0]);
        cache.insert(
            key(999, HttpVersion::Auto, ProxyMode::Auto),
            Arc::clone(&client),
        );

        assert_eq!(cache.entries.len(), CLIENT_CACHE_CAP);
        assert!(cache.entries.contains_key(&keys[0]), "touched key survives");
        assert!(
            !cache.entries.contains_key(&keys[1]),
            "least recently used key is evicted"
        );
        assert!(cache
            .entries
            .contains_key(&key(999, HttpVersion::Auto, ProxyMode::Auto)));
    }

    #[test]
    fn cache_keying_distinguishes_protocol_and_proxy_modes() {
        let http1 = key(0, HttpVersion::Http1, ProxyMode::Auto);
        let direct = key(0, HttpVersion::Auto, ProxyMode::Direct);
        let pinned = key(1, HttpVersion::Auto, ProxyMode::Pinned);

        let mut seen = std::collections::HashSet::new();
        assert!(seen.insert(DEFAULT_KEY));
        assert!(seen.insert(http1), "http1 is a distinct cache entry");
        assert!(seen.insert(direct), "direct proxy mode is distinct");
        assert!(seen.insert(pinned), "profile id is part of the key");
        assert_eq!(seen.len(), 4);
    }

    #[test]
    fn distinct_keys_produce_distinct_clients() {
        let auto = client_for(DEFAULT_KEY).expect("default client builds");
        let http1 =
            client_for(key(0, HttpVersion::Http1, ProxyMode::Auto)).expect("http1 client builds");
        let direct =
            client_for(key(0, HttpVersion::Auto, ProxyMode::Direct)).expect("direct client builds");

        assert!(!Arc::ptr_eq(&auto, &http1));
        assert!(!Arc::ptr_eq(&auto, &direct));
        // Same key returns the cached entry, not a rebuilt client.
        let again = client_for(DEFAULT_KEY).expect("cached client");
        assert!(Arc::ptr_eq(&auto, &again));
    }

    #[test]
    fn unknown_profile_id_is_rejected() {
        let error = client_for(key(4242, HttpVersion::Auto, ProxyMode::Auto))
            .expect_err("unregistered profile ids must not build a client");
        assert!(error.contains("unknown tls profile"));
    }
}
