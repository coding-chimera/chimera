//! Private native transport ABI for the Chimera runtime.
//!
//! This is an internal ABI, not a public one: the TypeScript layer in front of
//! it owns the public surface, provider selection and deadlines. Nothing here
//! leaks a JS engine's private ABI (no JSC/V8/Bun types), no `repr(Rust)`
//! struct crosses the boundary, and handles are opaque integers.
//!
//! Transport surface: http:// and https:// (rustls with platform trust,
//! env-merged extra roots, bundled-webpki fallback), HTTP/2 via ALPN on TLS,
//! env-discovered system proxies, streaming SSE bodies, explicit TLS profiles
//! (`configureTls`: custom CA, mTLS, verification override, pinned proxy), and
//! two pre-send connect-layer fallbacks (h2 -> http1, system proxy -> direct).
//! Redirects are followed manually and both fallbacks are eligible only on the
//! FIRST hop, before any response exists: they fire only on
//! `reqwest::Error::is_connect()` failures, which are then provably before
//! request bytes are on the wire. Anything else propagates unchanged, so a
//! redirect hop that fails to connect can never replay an already-sent POST.
//!
//! Exports (napi converts the snake_case names to camelCase):
//!
//! * `contractInfo()` — sync, `{ abiMajor, abiMinor, capabilities, build }`
//! * `startRequest(spec)` — sync, `{ handle }`
//! * `awaitHeaders(handle)` — Promise `{ status, statusText, headers, url, redirected }`
//! * `readBody(handle, maxBytes?)` — Promise of a Buffer (a `Uint8Array`
//!   subclass), or `null` at EOF
//! * `cancel(handle)` / `release(handle)` — sync, idempotent
//! * `configureTls(profile)` — sync, `{ profileId }` (ids are monotonic; `0`
//!   is reserved for the default platform-trust client)
//! * `stats()` — sync, monotonic counters plus live gauges
//!
//! Idle-reader reclamation: a handle with no activity for
//! `OPENCODE_RUST_TRANSPORT_IDLE_READER_TIMEOUT_MS` (default 300000, `0`
//! disables) is cancelled and released by a per-handle watchdog. "Active"
//! means a pending `readBody` OR a pending `awaitHeaders`; the idle clock
//! measures from the last readBody completion (or handle start), so actively
//! consumed streams and requests still waiting for headers are never touched.
//!
//! Compatibility rule: within `abiMajor = 1`, fields may only be added.

use std::sync::Arc;

use napi::bindgen_prelude::{Buffer, Either, Error, Result, Status, Uint8Array};
use napi_derive::napi;

mod buffer;
mod fallback;
mod profile;
mod request;
mod runtime;
mod stats;
#[cfg(test)]
mod testsupport;
mod tls;

use stats::STATS;

/// Installs the single process-wide Tokio runtime before any export runs.
/// `async fn` exports resolve on this runtime rather than one owned by napi.
#[napi_derive::module_init]
fn initialize_transport() {
    runtime::init();
}

#[napi(object)]
pub struct ContractInfo {
    pub abi_major: u32,
    pub abi_minor: u32,
    pub capabilities: Vec<String>,
    pub build: String,
}

#[napi(object)]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

#[napi(object)]
pub struct RequestSpec {
    pub url: String,
    pub method: String,
    /// Ordered, duplicate-preserving request headers.
    pub headers: Vec<HeaderPair>,
    /// `null`/absent for no body, a string, or a `Uint8Array`.
    pub body: Option<Either<String, Uint8Array>>,
    /// Only `"follow"` (or absent) is implemented in this version.
    pub redirect: Option<String>,
    /// `"auto"` (ALPN-negotiated h2/http1, the default) or `"http1"`.
    pub http_version: Option<String>,
    /// Registered TLS profile id; absent/`0` is platform trust.
    pub tls_profile: Option<u32>,
}

#[napi(object)]
pub struct ConfigureTlsProfile {
    /// PEM bundle merged into the profile's trust store.
    pub ca_pem: Option<String>,
    /// Client certificate chain PEM (requires `key_pem`).
    pub cert_pem: Option<String>,
    /// Private key PEM (requires `cert_pem`).
    pub key_pem: Option<String>,
    /// `false` disables certificate verification for this profile only.
    pub reject_unauthorized: Option<bool>,
    /// Verification name override for the TLS handshake.
    pub server_name: Option<String>,
    /// Explicit proxy pinned to this profile; never bypassed by a fallback.
    pub proxy: Option<String>,
}

#[napi(object)]
pub struct ConfigureTlsResult {
    pub profile_id: u32,
}

#[napi(object)]
pub struct StartResult {
    pub handle: u32,
}

#[napi(object)]
pub struct HeadersResult {
    pub status: u32,
    pub status_text: String,
    /// Ordered, duplicate-preserving response headers.
    pub headers: Vec<HeaderPair>,
    pub url: String,
    pub redirected: bool,
}

#[napi(object)]
pub struct StatsSnapshot {
    pub active_handles: i64,
    pub buffered_bytes: i64,
    pub cancelled_handles: i64,
    pub post_send_errors: i64,
    pub idle_reclaimed_handles: i64,
    /// Connect-layer protocol fallbacks (h2 -> http1) attempted.
    pub protocol_fallbacks: i64,
    /// Connect-layer route fallbacks (system proxy -> direct) attempted.
    pub route_fallbacks: i64,
    pub worker_threads: i64,
}

#[napi]
pub fn contract_info() -> ContractInfo {
    ContractInfo {
        abi_major: 1,
        abi_minor: 2,
        capabilities: vec![
            "http1".to_string(),
            "sse-stream".to_string(),
            "cancel".to_string(),
            "stats".to_string(),
            "idle-reclaim".to_string(),
            // Stage 1 of the TLS rollout (ABI 1.2): rustls/platform-verifier
            // https, ALPN h2, env-discovered system proxies.
            "tls".to_string(),
            "tls-platform".to_string(),
            "http2".to_string(),
            "proxy-system".to_string(),
            // Stage 2 (still ABI 1.2, additive fields only): explicit TLS
            // profiles, mTLS, and the two pre-send connect-layer fallbacks.
            "tls-custom-ca".to_string(),
            "mtls".to_string(),
            "fallback-protocol".to_string(),
            "fallback-route".to_string(),
        ],
        build: format!(
            "chimera-transport {} {}-{}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    }
}

#[napi]
pub fn start_request(spec: RequestSpec) -> Result<StartResult> {
    guarded(|| {
        let redirect = spec.redirect.as_deref().unwrap_or("follow");
        if redirect != "follow" {
            return Err(invalid_arg(format!(
                "unsupported redirect mode `{redirect}`: only `follow` is implemented"
            )));
        }

        let http_version =
            runtime::HttpVersion::parse(spec.http_version.as_deref()).map_err(invalid_arg)?;

        let body = match spec.body {
            None => None,
            Some(Either::A(text)) => Some(text.into_bytes()),
            Some(Either::B(bytes)) => Some(bytes.to_vec()),
        };

        let start = request::StartSpec {
            url: spec.url,
            method: spec.method,
            headers: spec
                .headers
                .into_iter()
                .map(|pair| (pair.name, pair.value))
                .collect(),
            body,
            follow_redirects: true,
            http_version,
            tls_profile: spec.tls_profile.unwrap_or(0),
        };

        let handle = request::start(start).map_err(failure)?;
        Ok(StartResult { handle })
    })
}

/// Register an immutable TLS/proxy profile. Ids are monotonic; `0` is
/// reserved for the default platform-trust client and is never returned.
#[napi]
pub fn configure_tls(profile: ConfigureTlsProfile) -> Result<ConfigureTlsResult> {
    guarded(|| {
        let id = profile::configure(profile::ProfileSpec {
            ca_pem: profile.ca_pem,
            cert_pem: profile.cert_pem,
            key_pem: profile.key_pem,
            reject_unauthorized: profile.reject_unauthorized,
            server_name: profile.server_name,
            proxy: profile.proxy,
        })
        .map_err(invalid_arg)?;
        Ok(ConfigureTlsResult { profile_id: id })
    })
}

#[napi]
pub async fn await_headers(handle: u32) -> Result<HeadersResult> {
    let state = lookup(handle)?;
    let snapshot = state.headers().await.map_err(failure)?;
    Ok(HeadersResult {
        status: snapshot.status,
        status_text: snapshot.status_text,
        headers: snapshot
            .headers
            .into_iter()
            .map(|(name, value)| HeaderPair { name, value })
            .collect(),
        url: snapshot.url,
        redirected: snapshot.redirected,
    })
}

#[napi]
pub async fn read_body(handle: u32, max_bytes: Option<u32>) -> Result<Option<Buffer>> {
    let state = lookup(handle)?;
    let chunk = state.read(read_max(max_bytes)).await.map_err(failure)?;
    // A Node Buffer is a Uint8Array; returning it keeps the zero-copy
    // `Vec<u8>` -> JS path without borrowing anything across the await.
    Ok(chunk.map(Buffer::from))
}

#[napi]
pub fn cancel(handle: u32) {
    if let Some(state) = request::get(handle) {
        state.cancel();
    }
}

#[napi]
pub fn release(handle: u32) {
    // Remove first: a second `release` must not find the handle and must not
    // count a second teardown. Waiters holding an `Arc` are still woken by
    // `release()` below and settle with a released error.
    if let Some(state) = request::remove(handle) {
        state.release();
    }
}

#[napi]
pub fn stats() -> StatsSnapshot {
    StatsSnapshot {
        active_handles: request::active_count(),
        buffered_bytes: request::total_buffered(),
        cancelled_handles: STATS.cancelled_handles() as i64,
        post_send_errors: STATS.post_send_errors() as i64,
        idle_reclaimed_handles: STATS.idle_reclaimed() as i64,
        protocol_fallbacks: STATS.protocol_fallbacks(),
        route_fallbacks: STATS.route_fallbacks(),
        worker_threads: STATS.worker_threads() as i64,
    }
}

fn read_max(max_bytes: Option<u32>) -> usize {
    match max_bytes {
        Some(value) if value > 0 => (value as usize).min(buffer::MAX_READ_MAX),
        _ => buffer::DEFAULT_READ_MAX,
    }
}

fn lookup(handle: u32) -> Result<Arc<request::RequestState>> {
    request::get(handle).ok_or_else(|| invalid_arg(format!("unknown transport handle {handle}")))
}

/// A panic must not cross the FFI boundary. Sync exports run their body through
/// this; async exports are guarded where it matters (the spawned network task
/// catches its own panics, and napi rejects the promise on a panicking poll).
fn guarded<T>(body: impl FnOnce() -> Result<T>) -> Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(_) => Err(Error::new(
            Status::GenericFailure,
            "transport export panicked",
        )),
    }
}

fn invalid_arg(message: String) -> Error {
    Error::new(Status::InvalidArg, message)
}

fn failure(message: String) -> Error {
    Error::new(Status::GenericFailure, message)
}
