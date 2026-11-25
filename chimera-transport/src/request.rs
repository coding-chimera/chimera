//! Per-request state, the handle registry, and the network task.
//!
//! Lifecycle of one handle:
//!
//! ```text
//! start()  -> registry insert, tokio task spawned (JS thread never blocks)
//!            task: send -> store headers -> drain bytes_stream into the queue
//! awaitHeaders()  waits on `data_notify` for headers / error / cancel
//! readBody()      drains the queue; empty queue waits on `data_notify`
//!                 for bytes / EOF / error / cancel
//! cancel()        flips state, aborts the network task, wakes both waiters
//! release()       registry remove + same cleanup, idempotent
//! ```
//!
//! Locking rule: the state mutex is only held for short, non-awaiting
//! sections. Every wait goes through `Notify` with the "create the future,
//! re-check the predicate, then await" pattern, so a wakeup cannot be lost
//! between the check and the wait.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{FutureExt, StreamExt};
use reqwest::header::{HeaderName, HeaderValue, LOCATION};
use reqwest::{Method, Url};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::buffer::{ByteQueue, DEFAULT_BUFFER_CAPACITY};
use crate::fallback::{self, FallbackKind};
use crate::runtime::{self, ClientKey, HttpVersion, ProxyMode};
use crate::stats::STATS;

/// Response head, as handed to `awaitHeaders`.
#[derive(Clone, Debug)]
pub struct HeaderSnapshot {
    pub status: u32,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub url: String,
    pub redirected: bool,
}

/// Plain-Rust request description. The napi layer converts the JS object into
/// this, so the state machine itself has no JS types in it.
pub struct StartSpec {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub follow_redirects: bool,
    /// Protocol preference; the fallback cache may force `Http1` for a
    /// destination that already needed the h2 -> http1 retry.
    pub http_version: HttpVersion,
    /// Registered TLS profile id; `0` is the platform-trust default.
    pub tls_profile: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Sending,
    Streaming,
    Done,
    Failed,
    Cancelled,
}

struct Inner {
    phase: Phase,
    headers: Option<HeaderSnapshot>,
    queue: ByteQueue,
    eof: bool,
    error: Option<String>,
    cancelled: bool,
    released: bool,
    /// One in-flight `readBody` per handle. Concurrent reads would interleave
    /// two JS callers on one byte stream, which is never what the caller means.
    reading: bool,
    /// A pending `awaitHeaders` protects the handle exactly like a pending
    /// read: the request is active until its response head arrives.
    /// Counted, not a bool: two concurrent `awaitHeaders` waiters share this
    /// handle, and the first finisher must not clear the second's protection.
    awaiting_headers: u32,
    /// Last readBody completion (or handle start); the idle watchdog measures
    /// inactivity from here. Updated under the same lock as `reading`.
    last_activity: Instant,
}

pub struct RequestState {
    pub id: u32,
    inner: Mutex<Inner>,
    data_notify: Notify,
    space_notify: Notify,
    stop_notify: Notify,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl RequestState {
    pub fn new(id: u32, capacity: usize) -> Self {
        Self {
            id,
            inner: Mutex::new(Inner {
                phase: Phase::Sending,
                headers: None,
                queue: ByteQueue::new(capacity),
                eof: false,
                error: None,
                cancelled: false,
                released: false,
                reading: false,
                awaiting_headers: 0,
                last_activity: Instant::now(),
            }),
            data_notify: Notify::new(),
            space_notify: Notify::new(),
            stop_notify: Notify::new(),
            task: Mutex::new(None),
        }
    }

    /// Poison-tolerant lock: a panic inside one critical section must not turn
    /// every later call on this handle into a panic of its own.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn stopped(&self) -> bool {
        let inner = self.lock();
        inner.cancelled || inner.released
    }

    pub fn buffered_len(&self) -> usize {
        self.lock().queue.len()
    }

    fn set_headers(&self, snapshot: HeaderSnapshot) {
        {
            let mut inner = self.lock();
            if inner.cancelled || inner.released {
                return;
            }
            inner.headers = Some(snapshot);
            inner.phase = Phase::Streaming;
        }
        self.data_notify.notify_waiters();
    }

    fn finish(&self) {
        {
            let mut inner = self.lock();
            inner.eof = true;
            if inner.phase == Phase::Streaming {
                inner.phase = Phase::Done;
            }
        }
        self.data_notify.notify_waiters();
        self.space_notify.notify_waiters();
    }

    /// Terminal failure. `post_send` distinguishes "the body stream broke"
    /// (counted in `postSendErrors`) from "the request never got an answer".
    fn fail(&self, message: String, post_send: bool) {
        if post_send {
            STATS.record_post_send_error();
        }
        {
            let mut inner = self.lock();
            if inner.cancelled || inner.released {
                return;
            }
            if inner.error.is_none() {
                inner.error = Some(message);
            }
            inner.phase = Phase::Failed;
        }
        self.data_notify.notify_waiters();
        self.space_notify.notify_waiters();
    }

    /// Copy one chunk into the queue, respecting the ceiling. Returns the
    /// number of bytes accepted (0 when full).
    fn try_push(&self, chunk: &Bytes) -> usize {
        let mut inner = self.lock();
        if inner.cancelled || inner.released {
            return 0;
        }
        inner.queue.push(chunk)
    }

    fn queue_full(&self) -> bool {
        self.lock().queue.is_full()
    }

    /// Writer side: push the whole chunk, waiting for the reader to drain when
    /// the buffer is full. Returning `false` means the request stopped
    /// (cancelled or released) and the network task should exit quietly.
    async fn push_all(&self, mut chunk: Bytes) -> bool {
        while !chunk.is_empty() {
            if self.stopped() {
                return false;
            }

            let accepted = self.try_push(&chunk);
            if accepted > 0 {
                chunk = chunk.slice(accepted..);
                self.data_notify.notify_waiters();
                continue;
            }

            // Buffer full: register interest first, then re-check, so a drain
            // that lands between the check and the await still wakes us.
            let notified = self.space_notify.notified();
            if self.stopped() || !self.queue_full() {
                continue;
            }
            notified.await;
        }
        true
    }

    fn abort_task(&self) {
        let handle = {
            let mut slot = self
                .task
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            slot.take()
        };
        if let Some(handle) = handle {
            handle.abort();
        }
    }

    /// Resolve once headers are available, or fail with the terminal reason.
    pub async fn headers(&self) -> Result<HeaderSnapshot, String> {
        {
            let mut inner = self.lock();
            inner.awaiting_headers += 1;
        }
        // Cleared on EVERY exit path (return, error, panic) like ReadGuard.
        let _guard = HeadersGuard { state: self };
        loop {
            {
                let inner = self.lock();
                if let Some(snapshot) = &inner.headers {
                    return Ok(snapshot.clone());
                }
                if inner.released {
                    return Err("request has been released".to_string());
                }
                if let Some(error) = &inner.error {
                    return Err(error.clone());
                }
                if inner.cancelled {
                    return Err("request was cancelled".to_string());
                }
                if inner.eof {
                    return Err("response ended before headers arrived".to_string());
                }
            }

            let notified = self.data_notify.notified();
            {
                let inner = self.lock();
                if inner.headers.is_some()
                    || inner.eof
                    || inner.error.is_some()
                    || inner.cancelled
                    || inner.released
                {
                    continue;
                }
            }
            notified.await;
        }
    }

    /// Read up to `max` bytes. `Ok(None)` means clean EOF. Buffered bytes are
    /// always handed out before a terminal error is reported, so a caller can
    /// still use a partially received body.
    pub async fn read(&self, max: usize) -> Result<Option<Vec<u8>>, String> {
        {
            let mut inner = self.lock();
            if inner.released {
                return Err("request has been released".to_string());
            }
            if inner.reading {
                return Err("readBody is already pending for this handle".to_string());
            }
            inner.reading = true;
        }
        let _guard = ReadGuard { state: self };

        loop {
            // Take bytes if any, otherwise surface the terminal state. The
            // lock is released before notifying the writer.
            let taken = {
                let mut inner = self.lock();
                if !inner.queue.is_empty() {
                    Some(inner.queue.take(max))
                } else {
                    if inner.released {
                        return Err("request has been released".to_string());
                    }
                    if let Some(error) = &inner.error {
                        return Err(error.clone());
                    }
                    if inner.cancelled {
                        return Err("request was cancelled".to_string());
                    }
                    if inner.eof {
                        return Ok(None);
                    }
                    None
                }
            };

            if let Some(chunk) = taken {
                self.space_notify.notify_waiters();
                return Ok(chunk);
            }

            let notified = self.data_notify.notified();
            {
                let inner = self.lock();
                if !inner.queue.is_empty()
                    || inner.eof
                    || inner.error.is_some()
                    || inner.cancelled
                    || inner.released
                {
                    continue;
                }
            }
            notified.await;
        }
    }

    /// Idempotent: only the first call transitions and counts.
    pub fn cancel(&self) {
        let first = {
            let mut inner = self.lock();
            if inner.cancelled || inner.released {
                false
            } else {
                inner.cancelled = true;
                inner.phase = Phase::Cancelled;
                inner.queue.clear();
                true
            }
        };
        if !first {
            return;
        }
        STATS.record_cancelled();
        self.abort_task();
        self.data_notify.notify_waiters();
        self.space_notify.notify_waiters();
        self.stop_notify.notify_waiters();
    }

    /// Idempotent teardown. Pending waiters are woken and observe `released`,
    /// so a late settlement resolves into an error instead of hanging.
    pub fn release(&self) {
        let first = {
            let mut inner = self.lock();
            if inner.released {
                false
            } else {
                inner.released = true;
                inner.cancelled = true;
                inner.phase = Phase::Cancelled;
                inner.queue.clear();
                true
            }
        };
        if !first {
            return;
        }
        self.abort_task();
        self.data_notify.notify_waiters();
        self.space_notify.notify_waiters();
        self.stop_notify.notify_waiters();
    }
}

struct ReadGuard<'a> {
    state: &'a RequestState,
}

impl Drop for ReadGuard<'_> {
    fn drop(&mut self) {
        let mut inner = self.state.lock();
        inner.reading = false;
        inner.last_activity = Instant::now();
    }
}

struct HeadersGuard<'a> {
    state: &'a RequestState,
}

impl Drop for HeadersGuard<'_> {
    fn drop(&mut self) {
        let mut inner = self.state.lock();
        inner.awaiting_headers = inner.awaiting_headers.saturating_sub(1);
    }
}

/// Start a request: validate, register the handle, spawn the network task.
/// Called from the JS thread, so it must not block and must not require an
/// ambient Tokio context.
///
/// The client is resolved here (not in the task) so a bad profile id or an
/// unbuildable client surfaces as a synchronous `startRequest` error, which
/// the TypeScript layer treats as a provably-pre-send fallback.
pub fn start(spec: StartSpec) -> Result<u32, String> {
    let runtime_handle =
        runtime::handle().ok_or_else(|| "transport runtime is not initialized".to_string())?;

    let profile = crate::profile::get(spec.tls_profile)
        .ok_or_else(|| format!("unknown tls profile id {}", spec.tls_profile))?;

    let url = Url::parse(&spec.url).map_err(|error| format!("invalid url: {error}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "unsupported url scheme `{other}`: this build speaks http and https only"
            ))
        }
    }

    if !spec.follow_redirects {
        return Err("unsupported redirect mode: only `follow` is implemented".to_string());
    }

    let method = Method::from_bytes(spec.method.to_ascii_uppercase().as_bytes())
        .map_err(|error| format!("invalid http method `{}`: {error}", spec.method))?;

    let headers = spec
        .headers
        .iter()
        .map(|(name, value)| {
            let header_name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| format!("invalid header name `{name}`: {error}"))?;
            let header_value = HeaderValue::from_str(value).map_err(|error| {
                format!(
                    "invalid value for header `{}`: {error}",
                    header_name.as_str()
                )
            })?;
            Ok((header_name, header_value))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let plan = RequestPlan {
        method,
        url: url.clone(),
        headers,
        body: spec.body,
    };

    // A pinned profile proxy never falls back to direct, so its mode is fixed
    // by the profile. Otherwise a destination that already needed the route
    // fallback starts on the direct client.
    let proxy_mode = if profile.has_pinned_proxy() {
        ProxyMode::Pinned
    } else if fallback::route_fallback_cached(&url) {
        ProxyMode::Direct
    } else {
        ProxyMode::Auto
    };
    let http_version =
        if spec.http_version == HttpVersion::Auto && fallback::protocol_fallback_cached(&url) {
            HttpVersion::Http1
        } else {
            spec.http_version
        };
    let key = ClientKey {
        profile_id: profile.id,
        http_version,
        proxy_mode,
    };
    let client = runtime::client_for(key)?;

    let state = Arc::new(RequestState::new(next_id(), DEFAULT_BUFFER_CAPACITY));
    registry_lock().insert(state.id, Arc::clone(&state));

    let task_state = Arc::clone(&state);
    let join = runtime_handle.spawn(async move {
        run(task_state, plan, key, client).await;
    });

    {
        let mut slot = state
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = Some(join);
    }

    if let Some(timeout) =
        parse_idle_timeout(std::env::var(IDLE_READER_TIMEOUT_ENV).ok().as_deref())
    {
        spawn_idle_watchdog(Arc::clone(&state), timeout);
    }

    Ok(state.id)
}

/// Everything needed to (re)build one logical request. Kept apart from
/// `RequestBuilder` because a `RequestBuilder` cannot be cloned: the fallback
/// retry has to construct a fresh builder on the fallback client.
struct RequestPlan {
    method: Method,
    url: Url,
    headers: Vec<(HeaderName, HeaderValue)>,
    body: Option<Vec<u8>>,
}

impl RequestPlan {
    fn build(&self, client: &reqwest::Client) -> reqwest::RequestBuilder {
        let mut builder = client.request(self.method.clone(), self.url.clone());
        for (name, value) in &self.headers {
            // Repeated names are appended, and insertion order is preserved,
            // so duplicate request headers survive the crossing.
            builder = builder.header(name.clone(), value.clone());
        }
        if let Some(body) = &self.body {
            builder = builder.body(body.clone());
        }
        builder
    }

    /// One redirect hop, replicating reqwest's tower-http transform exactly:
    /// 301/302 turn a POST into a bodyless GET (other methods keep their
    /// body), 303 turns everything except HEAD into a bodyless GET, and
    /// 307/308 preserve both method and body. Payload headers are dropped
    /// whenever the body is, and sensitive headers are stripped when the hop
    /// crosses origin.
    fn redirect(&self, next: Url, status: u16) -> Self {
        let mut method = self.method.clone();
        let mut body = self.body.clone();
        let mut headers = self.headers.clone();

        let drop_payload = match status {
            301 | 302 if method == Method::POST => {
                method = Method::GET;
                body = None;
                true
            }
            303 => {
                if method != Method::HEAD {
                    method = Method::GET;
                }
                body = None;
                true
            }
            _ => false,
        };

        if drop_payload {
            headers.retain(|(name, _)| !PAYLOAD_HEADERS.contains(&name.as_str()));
        }
        if !same_origin(&self.url, &next) {
            headers.retain(|(name, _)| !SENSITIVE_HEADERS.contains(&name.as_str()));
        }

        Self {
            method,
            url: next,
            headers,
            body,
        }
    }
}

/// Redirect statuses this transport follows. 300/304/305/306 are final
/// responses, exactly as in reqwest's tower-http policy.
fn follows_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// Upper bound on followed redirects per logical request. reqwest's former
/// `Policy::limited(20)` failed on the 21st redirect; the manual loop below
/// keeps that bound and surfaces it as an error.
const MAX_REDIRECT_HOPS: usize = 20;

/// Headers dropped when a redirect turns the request into a bodyless GET.
const PAYLOAD_HEADERS: [&str; 4] = [
    "content-type",
    "content-length",
    "content-encoding",
    "transfer-encoding",
];

/// Headers stripped when a redirect crosses origin (scheme, host or port),
/// matching reqwest's `remove_sensitive_headers`. `HeaderName` is normalized
/// to lowercase, so plain string comparison is exact.
const SENSITIVE_HEADERS: [&str; 5] = [
    "authorization",
    "cookie",
    "cookie2",
    "proxy-authorization",
    "www-authenticate",
];

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Network task body. The `catch_unwind` here is the FFI-adjacent guard: a
/// panic in this task must not leave waiters parked forever.
async fn run(
    state: Arc<RequestState>,
    plan: RequestPlan,
    key: ClientKey,
    client: Arc<reqwest::Client>,
) {
    let outcome = std::panic::AssertUnwindSafe(run_inner(Arc::clone(&state), plan, key, client))
        .catch_unwind()
        .await;

    if outcome.is_err() {
        state.fail("transport task panicked".to_string(), false);
    }
}

/// Send the logical request, following redirects MANUALLY.
///
/// Redirect traversal is deliberately not delegated to reqwest: with automatic
/// following, a connect failure on a later hop is indistinguishable from a
/// pre-send failure on the first one, so the fallback would replay an original
/// POST that a server already accepted (via the redirect). Here the fallback is
/// only eligible for hop 0, before any response exists; once hop 0 produced a
/// response — including a redirect — a later connect failure propagates.
async fn run_inner(
    state: Arc<RequestState>,
    plan: RequestPlan,
    key: ClientKey,
    client: Arc<reqwest::Client>,
) {
    let mut client = client;
    let mut current = plan;
    let mut hops = 0usize;
    // Set when the fallback client is in use and the retry has not answered
    // yet; a retry is only remembered once its destination actually responds.
    let mut pending_fallback: Option<FallbackKind> = None;

    let response = loop {
        match current.build(&client).send().await {
            Ok(response) => {
                if let Some(kind) = pending_fallback.take() {
                    match kind {
                        FallbackKind::Protocol => {
                            fallback::remember_protocol_fallback(&current.url)
                        }
                        FallbackKind::Route => fallback::remember_route_fallback(&current.url),
                    }
                }

                if !follows_redirect(response.status().as_u16()) {
                    break response;
                }
                if hops >= MAX_REDIRECT_HOPS {
                    state.fail(
                        format!(
                            "request failed: too many redirects (more than {MAX_REDIRECT_HOPS})"
                        ),
                        false,
                    );
                    return;
                }

                let next = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|location| current.url.join(location).ok());
                let Some(next) = next else {
                    // No usable Location: hand the 3xx back to the caller.
                    break response;
                };
                if !matches!(next.scheme(), "http" | "https") {
                    state.fail(
                        format!(
                            "request failed: redirect to unsupported scheme `{}`",
                            next.scheme()
                        ),
                        false,
                    );
                    return;
                }

                current = current.redirect(next, response.status().as_u16());
                hops += 1;
            }
            Err(error) => {
                // Strict pre-send gate, first hop only: `is_connect` is true
                // only for TCP connect, TLS handshake and proxy CONNECT
                // failures — provably before any request bytes. Once a hop has
                // produced a response, or a fallback retry is already in
                // flight, nothing is retried: the logical request is already
                // on the wire and a replay would duplicate it.
                if hops == 0 && pending_fallback.is_none() && error.is_connect() {
                    match attempt_fallback(&current, key, &error) {
                        Ok((next_client, kind)) => {
                            client = next_client;
                            pending_fallback = Some(kind);
                            continue;
                        }
                        Err(message) => {
                            state.fail(message, false);
                            return;
                        }
                    }
                }
                state.fail(format!("request failed: {error}"), false);
                return;
            }
        }
    };

    let snapshot = HeaderSnapshot {
        status: response.status().as_u16() as u32,
        status_text: response
            .status()
            .canonical_reason()
            .unwrap_or_default()
            .to_string(),
        headers: response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect(),
        url: current.url.as_str().to_string(),
        // Tracked explicitly by the manual loop: a hop count above zero means
        // this request followed at least one redirect, even if the chain came
        // back to the URL it started from.
        redirected: hops > 0,
    };
    state.set_headers(snapshot);

    let mut stream = response.bytes_stream();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) if chunk.is_empty() => continue,
            Ok(chunk) => {
                if !state.push_all(chunk).await {
                    return;
                }
            }
            Err(error) => {
                state.fail(format!("response body failed: {error}"), true);
                return;
            }
        }
    }

    state.finish();
}

/// Decide the single retry allowed after a hop-0 connect-layer failure and
/// return the fallback client. The counter is bumped when the retry is issued
/// so operators can see that the fallback path ran at all; the destination is
/// remembered later, once the retried request actually answers.
fn attempt_fallback(
    plan: &RequestPlan,
    key: ClientKey,
    original: &reqwest::Error,
) -> Result<(Arc<reqwest::Client>, FallbackKind), String> {
    let Some((next, kind)) =
        fallback::next_attempt(key, &plan.url, fallback::proxy_env_configured())
    else {
        return Err(format!("request failed: {original}"));
    };

    let client = runtime::client_for(next).map_err(|error| {
        format!("request failed: {original} (fallback client unavailable: {error})")
    })?;

    match kind {
        FallbackKind::Protocol => STATS.record_protocol_fallback(),
        FallbackKind::Route => STATS.record_route_fallback(),
    }

    Ok((client, kind))
}

/// Default idle-reader ceiling: 5 minutes with no readBody activity.
const DEFAULT_IDLE_READER_TIMEOUT: Duration = Duration::from_millis(300_000);
const IDLE_READER_TIMEOUT_ENV: &str = "OPENCODE_RUST_TRANSPORT_IDLE_READER_TIMEOUT_MS";

/// Parse the idle-reader timeout env: unset/invalid keeps the default, `0`
/// disables reclamation entirely.
fn parse_idle_timeout(raw: Option<&str>) -> Option<Duration> {
    match raw.map(str::trim) {
        None => Some(DEFAULT_IDLE_READER_TIMEOUT),
        Some("0") => None,
        Some(value) => match value.parse::<u64>() {
            Ok(ms) if ms > 0 => Some(Duration::from_millis(ms)),
            _ => Some(DEFAULT_IDLE_READER_TIMEOUT),
        },
    }
}

impl RequestState {
    /// (activity pending, idle duration). A pending readBody OR a pending
    /// awaitHeaders counts as activity: actively consumed streams and requests
    /// still waiting for their response head must never be reclaimed.
    fn idle_snapshot(&self) -> (bool, Duration) {
        let inner = self.lock();
        (
            inner.reading || inner.awaiting_headers > 0,
            inner.last_activity.elapsed(),
        )
    }
}

/// Remove `id` only while the registry still holds exactly `expected`, then
/// tear it down. Returns whether this call performed the reclaim.
///
/// The activity/idle re-check happens under the per-handle state lock and the
/// registry removal happens before that lock is released, so a waiter that
/// registers `readBody`/`awaitHeaders` can never slip between the watchdog's
/// decision and the removal: it either registers first (and is seen by the
/// re-check) or finds the handle released afterwards. Lock order is always
/// state -> registry; no other path holds the registry lock while taking a
/// state lock, so this cannot deadlock. The `Arc::ptr_eq` identity guard keeps
/// a stale watchdog from ever touching a reused handle id.
fn reclaim_idle(id: u32, expected: &Arc<RequestState>, timeout: Duration) -> bool {
    let inner = expected.lock();
    if inner.reading || inner.awaiting_headers > 0 || inner.last_activity.elapsed() < timeout {
        return false;
    }

    {
        let mut registry = registry_lock();
        match registry.get(&id) {
            Some(current) if Arc::ptr_eq(current, expected) => {
                registry.remove(&id);
                // Counted while the registry lock is still held: an observer
                // that sees the handle gone must also see the counter bumped,
                // so the reclaim never looks torn from outside.
                STATS.record_idle_reclaimed();
            }
            _ => return false,
        }
    }

    // Drop the state lock before release(), which takes it again.
    drop(inner);
    expected.release();
    true
}

/// Per-handle idle-reader watchdog: reclaim after `timeout` with no readBody
/// activity. A pending read or pending `awaitHeaders` protects the stream;
/// normal cancel/release wakes it through stop_notify so it exits promptly.
/// No lock is held across an await, and the reclaim decision is re-verified
/// atomically in [`reclaim_idle`].
async fn idle_watchdog(state: Arc<RequestState>, timeout: Duration) {
    loop {
        let notified = state.stop_notify.notified();
        if state.stopped() {
            return;
        }
        let (active, idle) = state.idle_snapshot();
        if !active && idle >= timeout {
            if reclaim_idle(state.id, &state, timeout) {
                return;
            }
            // Activity registered before the decision: re-evaluate instead of
            // treating a failed reclaim as terminal.
            continue;
        }
        // While a read or headers wait is pending, re-check after a full
        // interval instead of reclaiming.
        let sleep_for = if active {
            timeout
        } else {
            timeout.saturating_sub(idle)
        };
        tokio::select! {
            _ = tokio::time::sleep(sleep_for) => {}
            _ = notified => return,
        }
    }
}

/// Spawn the watchdog on the shared runtime. A missing runtime is already a
/// hard start() error, so skipping here cannot strand a live handle.
pub fn spawn_idle_watchdog(state: Arc<RequestState>, timeout: Duration) {
    if let Some(handle) = runtime::handle() {
        handle.spawn(async move { idle_watchdog(state, timeout).await });
    }
}

fn next_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    loop {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        // 0 is reserved as "never a handle", and the wrap point is far beyond
        // any process lifetime; skipping it keeps ids in the JS safe range.
        if id != 0 {
            return id;
        }
    }
}

fn registry() -> &'static Mutex<HashMap<u32, Arc<RequestState>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u32, Arc<RequestState>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn registry_lock() -> MutexGuard<'static, HashMap<u32, Arc<RequestState>>> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn get(id: u32) -> Option<Arc<RequestState>> {
    registry_lock().get(&id).cloned()
}

pub fn remove(id: u32) -> Option<Arc<RequestState>> {
    registry_lock().remove(&id)
}

pub fn active_count() -> i64 {
    registry_lock().len() as i64
}

/// Exact sum of every live handle's buffered bytes. The registry lock is
/// dropped before the per-handle locks are taken, so this cannot deadlock
/// against a writer that only ever takes its own handle lock.
pub fn total_buffered() -> i64 {
    let handles: Vec<Arc<RequestState>> = registry_lock().values().cloned().collect();
    handles
        .iter()
        .map(|state| state.buffered_len() as i64)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn state(capacity: usize) -> Arc<RequestState> {
        Arc::new(RequestState::new(1, capacity))
    }

    fn snapshot(status: u32) -> HeaderSnapshot {
        HeaderSnapshot {
            status,
            status_text: "OK".to_string(),
            headers: vec![("content-type".to_string(), "text/event-stream".to_string())],
            url: "http://example.test/stream".to_string(),
            redirected: false,
        }
    }

    #[tokio::test]
    async fn headers_resolve_after_they_are_stored() {
        let state = state(1024);
        state.set_headers(snapshot(200));
        let headers = state.headers().await.expect("headers are available");
        assert_eq!(headers.status, 200);
        assert_eq!(headers.headers[0].0, "content-type");
    }

    #[tokio::test]
    async fn pending_headers_wake_up_on_cancel() {
        let state = state(1024);
        let reader = {
            let state = Arc::clone(&state);
            tokio::spawn(async move { state.headers().await })
        };
        tokio::task::yield_now().await;
        assert!(!reader.is_finished());

        state.cancel();
        let outcome = tokio::time::timeout(Duration::from_secs(1), reader)
            .await
            .expect("cancelled waiter is woken")
            .expect("task did not panic");
        assert!(outcome.is_err());
    }

    #[tokio::test]
    async fn pending_headers_wake_up_on_release() {
        let state = state(1024);
        let reader = {
            let state = Arc::clone(&state);
            tokio::spawn(async move { state.headers().await })
        };
        tokio::task::yield_now().await;

        state.release();
        let outcome = tokio::time::timeout(Duration::from_secs(1), reader)
            .await
            .expect("released waiter is woken")
            .expect("task did not panic");
        assert!(outcome.is_err());
    }

    #[tokio::test]
    async fn read_returns_eof_only_after_the_stream_finishes() {
        let state = state(1024);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), state.read(64))
                .await
                .is_err(),
            "an empty, still-open stream must not report EOF"
        );

        state.finish();
        assert_eq!(state.read(64).await.expect("no error"), None);
    }

    #[tokio::test]
    async fn concurrent_reads_are_rejected() {
        let state = state(1024);
        {
            let mut inner = state.lock();
            inner.reading = true;
        }
        let error = state.read(64).await.expect_err("second read is refused");
        assert!(error.contains("already pending"));

        // The guard from the refused call must not clear the flag it did not set.
        assert!(state.lock().reading);
    }

    #[tokio::test]
    async fn buffered_bytes_are_drained_before_a_terminal_error() {
        let state = state(1024);
        assert_eq!(state.try_push(&Bytes::from_static(b"partial")), 7);
        state.fail("boom".to_string(), true);

        assert_eq!(
            state.read(64).await.expect("buffered bytes win"),
            Some(b"partial".to_vec())
        );
        let error = state.read(64).await.expect_err("then the error surfaces");
        assert!(error.contains("boom"));
    }

    #[tokio::test]
    async fn writer_stops_at_the_ceiling_and_resumes_after_a_drain() {
        let state = state(8);
        let writer = {
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                state
                    .push_all(Bytes::from_static(b"0123456789abcdef"))
                    .await
            })
        };

        tokio::time::timeout(Duration::from_secs(1), async {
            while state.buffered_len() < 8 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("writer fills the buffer");

        assert!(!writer.is_finished(), "writer must block on a full buffer");
        assert_eq!(state.buffered_len(), 8);

        assert_eq!(
            state.read(8).await.expect("drain"),
            Some(b"01234567".to_vec())
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(1), writer)
                .await
                .expect("writer resumes after the drain")
                .expect("task did not panic"),
            "writer ran to completion"
        );
        assert_eq!(state.buffered_len(), 8);
        assert_eq!(
            state.read(64).await.expect("rest of the chunk"),
            Some(b"89abcdef".to_vec())
        );
        state.finish();
        assert_eq!(state.read(64).await.expect("eof after finish"), None);
    }

    #[tokio::test]
    async fn cancel_is_idempotent_and_clears_the_buffer() {
        let state = state(1024);
        state.try_push(&Bytes::from_static(b"abc"));
        state.cancel();
        let after_first = STATS.cancelled_handles();
        state.cancel();
        state.cancel();

        // Idempotent: extra cancels must not bump the counter. Comparing
        // against the post-first-call value keeps this immune to other tests
        // cancelling handles concurrently.
        assert_eq!(STATS.cancelled_handles(), after_first);
        assert_eq!(state.buffered_len(), 0);
        assert!(state.read(64).await.is_err());
    }

    #[tokio::test]
    async fn release_is_idempotent() {
        let state = state(1024);
        state.release();
        state.release();
        assert!(state.read(64).await.is_err());
        assert!(state.headers().await.is_err());
    }

    #[test]
    fn ids_are_unique_and_never_zero() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..300 {
            let id = next_id();
            assert_ne!(id, 0);
            assert!(seen.insert(id), "handle ids must not be reused");
        }
        // 300 handles at the default ceiling stay well inside one process's
        // memory budget and inside the JS safe-integer range.
        assert!((300 * DEFAULT_BUFFER_CAPACITY) < i32::MAX as usize * 8);
    }

    #[test]
    fn idle_timeout_parsing_defaults_disables_and_rejects_garbage() {
        assert_eq!(parse_idle_timeout(None), Some(DEFAULT_IDLE_READER_TIMEOUT));
        assert_eq!(parse_idle_timeout(Some("0")), None);
        assert_eq!(parse_idle_timeout(Some(" 0 ")), None);
        assert_eq!(
            parse_idle_timeout(Some("1500")),
            Some(Duration::from_millis(1500))
        );
        assert_eq!(
            parse_idle_timeout(Some("garbage")),
            Some(DEFAULT_IDLE_READER_TIMEOUT)
        );
        assert_eq!(
            parse_idle_timeout(Some("-5")),
            Some(DEFAULT_IDLE_READER_TIMEOUT)
        );
    }

    /// The idle-watchdog tests assert exact deltas on the process-global STATS
    /// counters and share one leaked runtime, so they must not interleave.
    static IDLE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn idle_watchdog_reclaims_a_small_body_abandoned_after_eof() {
        let _serial = IDLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = Arc::new(RequestState::new(next_id(), 1024));
        registry_lock().insert(state.id, Arc::clone(&state));
        state.set_headers(snapshot(200));
        state.try_push(&Bytes::from_static(b"small"));
        state.finish();
        let before = STATS.idle_reclaimed();

        spawn_idle_watchdog(Arc::clone(&state), Duration::from_millis(50));
        tokio::time::timeout(Duration::from_secs(2), async {
            while get(state.id).is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("abandoned EOF handle is reclaimed");
        assert!(state.stopped());
        assert_eq!(STATS.idle_reclaimed(), before + 1);
    }

    #[tokio::test]
    async fn idle_watchdog_reclaims_a_buffer_full_abandoned_stream_and_unblocks_the_writer() {
        let _serial = IDLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = Arc::new(RequestState::new(next_id(), 8));
        registry_lock().insert(state.id, Arc::clone(&state));
        state.set_headers(snapshot(200));
        let writer = {
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                state
                    .push_all(Bytes::from_static(b"0123456789abcdef"))
                    .await
            })
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.buffered_len() < 8 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("writer fills the buffer");
        let before = STATS.idle_reclaimed();

        spawn_idle_watchdog(Arc::clone(&state), Duration::from_millis(50));
        let outcome = tokio::time::timeout(Duration::from_secs(2), writer)
            .await
            .expect("writer is unblocked by the reclaim")
            .expect("task did not panic");
        assert!(!outcome, "writer exits quietly once the handle stopped");
        assert!(get(state.id).is_none());
        assert_eq!(STATS.idle_reclaimed(), before + 1);
    }

    #[tokio::test]
    async fn idle_watchdog_never_reclaims_while_a_read_is_pending() {
        let _serial = IDLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = Arc::new(RequestState::new(next_id(), 1024));
        registry_lock().insert(state.id, Arc::clone(&state));
        state.set_headers(snapshot(200));
        let reader = {
            let state = Arc::clone(&state);
            tokio::spawn(async move { state.read(64).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!reader.is_finished());

        spawn_idle_watchdog(Arc::clone(&state), Duration::from_millis(30));
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(
            get(state.id).is_some(),
            "a pending read protects the handle"
        );
        assert!(!reader.is_finished());

        state.try_push(&Bytes::from_static(b"data"));
        // try_push is the raw queue helper; production's push_all notifies
        // readers after a successful push — mirror that here.
        state.data_notify.notify_waiters();
        let chunk = tokio::time::timeout(Duration::from_secs(1), reader)
            .await
            .expect("reader is woken")
            .expect("task did not panic");
        assert_eq!(chunk.expect("no error"), Some(b"data".to_vec()));

        // Abandoned after the read completed: now the reclaim may happen.
        tokio::time::timeout(Duration::from_secs(2), async {
            while get(state.id).is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("abandoned handle is reclaimed after the last read");
    }

    #[tokio::test]
    async fn stale_watchdog_cannot_remove_a_reused_handle_id() {
        let _serial = IDLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let old = Arc::new(RequestState::new(next_id(), 1024));
        let id = old.id;
        registry_lock().insert(id, Arc::clone(&old));
        spawn_idle_watchdog(Arc::clone(&old), Duration::from_millis(30));
        // Simulate teardown + id reuse BEFORE the watchdog fires; the old
        // state is intentionally not stopped so the identity guard is exercised.
        let replacement = Arc::new(RequestState::new(id, 1024));
        {
            let mut registry = registry_lock();
            registry.remove(&id);
            registry.insert(id, Arc::clone(&replacement));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            get(id).is_some(),
            "the new occupant must survive the stale watchdog"
        );
        assert!(Arc::ptr_eq(
            &get(id).expect("still registered"),
            &replacement
        ));
        registry_lock().remove(&id);
        replacement.release();
    }

    #[tokio::test]
    async fn idle_watchdog_never_reclaims_while_headers_are_pending() {
        let _serial = IDLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = Arc::new(RequestState::new(next_id(), 1024));
        registry_lock().insert(state.id, Arc::clone(&state));
        let waiter = {
            let state = Arc::clone(&state);
            tokio::spawn(async move { state.headers().await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!waiter.is_finished());

        spawn_idle_watchdog(Arc::clone(&state), Duration::from_millis(30));
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(
            get(state.id).is_some(),
            "pending awaitHeaders protects the handle"
        );
        assert!(!waiter.is_finished());

        state.set_headers(snapshot(200));
        let head = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("headers waiter is woken")
            .expect("task did not panic");
        assert_eq!(head.expect("no error").status, 200);

        // Headers delivered and no read activity afterwards: the idle clock
        // now runs from the last activity and the abandoned handle reclaims.
        tokio::time::timeout(Duration::from_secs(2), async {
            while get(state.id).is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("handle without reads is reclaimed after headers");
    }

    #[tokio::test]
    async fn idle_clock_after_headers_follows_read_activity() {
        let _serial = IDLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = Arc::new(RequestState::new(next_id(), 1024));
        registry_lock().insert(state.id, Arc::clone(&state));
        state.set_headers(snapshot(200));
        // headers() returns immediately; the guard clears awaiting_headers.
        assert!(state.headers().await.is_ok());
        spawn_idle_watchdog(Arc::clone(&state), Duration::from_millis(80));
        // Keep reading inside the idle window: every read resets the clock.
        for _ in 0..4 {
            tokio::time::sleep(Duration::from_millis(40)).await;
            state.try_push(&Bytes::from_static(b"x"));
            assert_eq!(state.read(64).await.expect("no error"), Some(b"x".to_vec()));
            assert!(
                get(state.id).is_some(),
                "active reads keep the handle alive"
            );
        }
        // Abandon: reclaim follows the LAST READ, not the headers completion.
        tokio::time::timeout(Duration::from_secs(2), async {
            while get(state.id).is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("abandoned handle is reclaimed after the last read");
    }

    /// BUG #3 regression: the header-waiter protection is counted, so one
    /// finisher cannot clear another waiter's protection.
    #[tokio::test]
    async fn concurrent_headers_waiters_are_counted() {
        let _serial = IDLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = Arc::new(RequestState::new(next_id(), 1024));

        let waiters: Vec<_> = (0..3)
            .map(|_| {
                let state = Arc::clone(&state);
                tokio::spawn(async move { state.headers().await })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(state.lock().awaiting_headers, 3);

        state.set_headers(snapshot(200));
        for waiter in waiters {
            let head = tokio::time::timeout(Duration::from_secs(1), waiter)
                .await
                .expect("waiter is woken")
                .expect("task did not panic");
            assert_eq!(head.expect("no error").status, 200);
        }
        assert_eq!(
            state.lock().awaiting_headers,
            0,
            "every waiter must decrement the count on drop"
        );
    }

    /// BUG #3 regression: several concurrent header waiters protect the handle
    /// for as long as ANY of them is pending.
    #[tokio::test]
    async fn idle_watchdog_never_reclaims_while_any_headers_waiter_is_pending() {
        let _serial = IDLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = Arc::new(RequestState::new(next_id(), 1024));
        registry_lock().insert(state.id, Arc::clone(&state));

        let waiters: Vec<_> = (0..3)
            .map(|_| {
                let state = Arc::clone(&state);
                tokio::spawn(async move { state.headers().await })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(10)).await;

        spawn_idle_watchdog(Arc::clone(&state), Duration::from_millis(30));
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(
            get(state.id).is_some(),
            "pending header waiters protect the handle"
        );
        assert!(waiters.iter().all(|waiter| !waiter.is_finished()));

        state.set_headers(snapshot(200));
        for waiter in waiters {
            let head = tokio::time::timeout(Duration::from_secs(1), waiter)
                .await
                .expect("waiter is woken")
                .expect("task did not panic");
            assert_eq!(head.expect("no error").status, 200);
        }
    }

    /// BUG #3 regression: the reclaim decision re-checks activity and idle
    /// elapsed under the state lock, so a waiter that registered after the
    /// watchdog's snapshot is never reclaimed.
    #[tokio::test]
    async fn reclaim_rechecks_activity_under_the_state_lock() {
        let _serial = IDLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = Arc::new(RequestState::new(next_id(), 1024));
        registry_lock().insert(state.id, Arc::clone(&state));

        // Simulate the watchdog's stale snapshot: the clock already looks idle.
        {
            let mut inner = state.lock();
            inner.last_activity = Instant::now() - Duration::from_secs(10);
        }

        // A readBody registers between the snapshot and the reclaim decision.
        {
            let mut inner = state.lock();
            inner.reading = true;
        }
        assert!(
            !reclaim_idle(state.id, &state, Duration::from_millis(1)),
            "a registered reader must veto the reclaim"
        );
        assert!(get(state.id).is_some());
        assert!(!state.stopped());

        // Same for a pending awaitHeaders.
        {
            let mut inner = state.lock();
            inner.reading = false;
            inner.awaiting_headers = 1;
        }
        assert!(
            !reclaim_idle(state.id, &state, Duration::from_millis(1)),
            "a registered headers waiter must veto the reclaim"
        );
        assert!(get(state.id).is_some());

        // And a fresh activity clock vetoes it even with no waiter.
        {
            let mut inner = state.lock();
            inner.awaiting_headers = 0;
            inner.last_activity = Instant::now();
        }
        assert!(
            !reclaim_idle(state.id, &state, Duration::from_millis(1)),
            "an active clock must veto the reclaim"
        );
        assert!(get(state.id).is_some());

        // Truly idle: the reclaim proceeds and removes the handle.
        {
            let mut inner = state.lock();
            inner.last_activity = Instant::now() - Duration::from_secs(10);
        }
        assert!(reclaim_idle(state.id, &state, Duration::from_millis(1)));
        assert!(get(state.id).is_none());
        assert!(state.stopped());
    }
}

/// Fallback integration tests live in their own module because they drive
/// the real network task and assert process-global counter deltas.
#[cfg(test)]
mod fallback_tests {
    use super::*;

    /// These tests assert exact deltas on process-global counters and mutate
    /// proxy env vars, so they must not interleave.
    static FALLBACK_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const PROXY_ENV: [&str; 6] = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ];

    /// Neutralize env proxies for the duration of one test. Empty counts as
    /// unset in `fallback::proxy_env_configured`.
    fn clear_proxy_env() -> Vec<(&'static str, Option<String>)> {
        PROXY_ENV
            .iter()
            .map(|key| {
                let previous = std::env::var(key).ok();
                std::env::set_var(key, "");
                (*key, previous)
            })
            .collect()
    }

    fn restore_proxy_env(previous: Vec<(&'static str, Option<String>)>) {
        for (key, value) in previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    fn test_plan(url: &str) -> RequestPlan {
        RequestPlan {
            method: Method::GET,
            url: Url::parse(url).expect("test url parses"),
            headers: Vec::new(),
            body: None,
        }
    }

    fn default_key() -> ClientKey {
        ClientKey {
            profile_id: 0,
            http_version: HttpVersion::Auto,
            proxy_mode: ProxyMode::Auto,
        }
    }

    /// A port with nothing listening: connect is refused immediately, which
    /// is the cheapest way to produce a real `is_connect()` error offline.
    async fn closed_port_url(scheme: &str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind an ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        drop(listener);
        format!("{scheme}://127.0.0.1:{port}/")
    }

    #[tokio::test]
    async fn connect_error_is_classified_pre_send() {
        let _serial = FALLBACK_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let client = runtime::client_for(default_key()).expect("default client builds");
        let plan = test_plan(&closed_port_url("http").await);

        let error = plan.build(&client).send().await.expect_err("connect fails");
        assert!(
            error.is_connect(),
            "a refused TCP connect must be the pre-send class: {error}"
        );
    }

    #[tokio::test]
    async fn connect_failure_fires_one_protocol_fallback_and_counts_it() {
        let _serial = FALLBACK_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();
        let before = STATS.protocol_fallbacks();
        let target = closed_port_url("https").await;
        let key = default_key();
        let client = runtime::client_for(key).expect("default client builds");
        let state = Arc::new(RequestState::new(next_id(), DEFAULT_BUFFER_CAPACITY));

        run_inner(Arc::clone(&state), test_plan(&target), key, client).await;

        assert_eq!(
            STATS.protocol_fallbacks(),
            before + 1,
            "the h2 -> http1 retry must be counted exactly once"
        );
        assert!(state.headers().await.is_err(), "the retry also fails");
        restore_proxy_env(previous_env);
    }

    #[tokio::test]
    async fn non_connect_send_failure_propagates_without_any_retry() {
        use tokio::io::AsyncWriteExt;

        let _serial = FALLBACK_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();
        let before_protocol = STATS.protocol_fallbacks();
        let before_route = STATS.route_fallbacks();

        // Accept, answer with something that is not HTTP, then close: the
        // failure lands after the request bytes are on the wire. Plaintext is
        // used on purpose — a TLS handshake failure would be a connect error.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind an ephemeral port");
        let address = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let _ = stream.write_all(b"GARBAGE\r\n\r\n").await;
                drop(stream);
            }
        });

        let target = format!("http://127.0.0.1:{}/", address.port());
        let key = default_key();
        let client = runtime::client_for(key).expect("default client builds");

        // Classifier boundary: this error must NOT look like a connect error.
        let error = test_plan(&target)
            .build(&client)
            .send()
            .await
            .expect_err("the malformed response fails the request");
        assert!(
            !error.is_connect(),
            "a post-send protocol failure must never be the pre-send class: {error}"
        );

        let state = Arc::new(RequestState::new(next_id(), DEFAULT_BUFFER_CAPACITY));
        run_inner(Arc::clone(&state), test_plan(&target), key, client).await;

        assert_eq!(STATS.protocol_fallbacks(), before_protocol);
        assert_eq!(STATS.route_fallbacks(), before_route);
        assert!(state.headers().await.is_err(), "the request failed");
        restore_proxy_env(previous_env);
    }

    fn raw_response(status: &str, headers: &[(&str, &str)], body: &str) -> String {
        let mut out = String::new();
        out.push_str("HTTP/1.1 ");
        out.push_str(status);
        out.push_str("\r\n");
        out.push_str(&format!("Content-Length: {}\r\n", body.len()));
        out.push_str("Connection: close\r\n");
        for (name, value) in headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str("\r\n");
        out.push_str(body);
        out
    }

    fn post_plan(url: &str, body: &[u8]) -> RequestPlan {
        RequestPlan {
            method: Method::POST,
            url: Url::parse(url).expect("test url parses"),
            headers: Vec::new(),
            body: Some(body.to_vec()),
        }
    }

    /// BUG #1 regression: a connect failure on a redirect hop is POST-SEND for
    /// the logical request. The fallback must not fire and the original POST
    /// must never be replayed to a server that already answered.
    #[tokio::test]
    async fn redirect_hop_connect_failure_never_replays_the_post() {
        let _serial = FALLBACK_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();
        let before_protocol = STATS.protocol_fallbacks();
        let before_route = STATS.route_fallbacks();
        let unreachable = closed_port_url("http").await;

        let server = crate::testsupport::spawn_tls_server(move |_method, _body, _head| {
            raw_response("307 Temporary Redirect", &[("Location", &unreachable)], "")
        });

        // A profile that trusts the fixture CA makes hop 0 reachable, so the
        // server really answers before the redirect target fails to connect.
        let profile_id = crate::profile::configure(crate::profile::ProfileSpec {
            ca_pem: Some(crate::testsupport::CA_PEM.to_string()),
            cert_pem: None,
            key_pem: None,
            reject_unauthorized: None,
            server_name: None,
            proxy: None,
        })
        .expect("profile registers");
        let key = ClientKey {
            profile_id,
            http_version: HttpVersion::Auto,
            proxy_mode: ProxyMode::Auto,
        };
        let client = runtime::client_for(key).expect("profile client builds");
        let state = Arc::new(RequestState::new(next_id(), DEFAULT_BUFFER_CAPACITY));
        let target = server.https_url("/start");
        run_inner(
            Arc::clone(&state),
            post_plan(&target, b"model-call-payload"),
            key,
            client,
        )
        .await;

        assert_eq!(
            server.request_count(),
            1,
            "the redirecting server must receive exactly one POST"
        );
        assert_eq!(
            STATS.protocol_fallbacks(),
            before_protocol,
            "a post-send connect failure must not trigger a protocol fallback"
        );
        assert_eq!(
            STATS.route_fallbacks(),
            before_route,
            "a post-send connect failure must not trigger a route fallback"
        );
        assert!(state.headers().await.is_err(), "the error propagates");
        restore_proxy_env(previous_env);
    }

    /// 307 preserves method and body; the final response comes from the target.
    #[tokio::test]
    async fn redirect_307_preserves_method_and_body() {
        let _serial = FALLBACK_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();
        let target = crate::testsupport::spawn_http_server(|method, body, _head| {
            raw_response("200 OK", &[], &format!("{method}:{}", body.len()))
        });
        let target_url = target.url("/final");
        let origin = crate::testsupport::spawn_http_server(move |_method, _body, _head| {
            raw_response("307 Temporary Redirect", &[("Location", &target_url)], "")
        });

        let key = default_key();
        let client = runtime::client_for(key).expect("default client builds");
        let state = Arc::new(RequestState::new(next_id(), DEFAULT_BUFFER_CAPACITY));
        let start = origin.url("/start");
        run_inner(Arc::clone(&state), post_plan(&start, b"hello"), key, client).await;

        let head = state.headers().await.expect("final response arrives");
        assert_eq!(head.status, 200);
        assert!(head.redirected, "the manual loop must report the redirect");
        assert_eq!(head.url, target.url("/final"));
        assert_eq!(
            state.read(64).await.expect("body"),
            Some(b"POST:5".to_vec())
        );
        assert_eq!(origin.request_count(), 1);
        assert_eq!(target.request_count(), 1);
        restore_proxy_env(previous_env);
    }

    /// 303 turns a POST into a bodyless GET.
    #[tokio::test]
    async fn redirect_303_turns_post_into_get() {
        let _serial = FALLBACK_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();
        let target = crate::testsupport::spawn_http_server(|method, body, _head| {
            raw_response("200 OK", &[], &format!("{method}:{}", body.len()))
        });
        let target_url = target.url("/final");
        let origin = crate::testsupport::spawn_http_server(move |_method, _body, _head| {
            raw_response("303 See Other", &[("Location", &target_url)], "")
        });

        let key = default_key();
        let client = runtime::client_for(key).expect("default client builds");
        let state = Arc::new(RequestState::new(next_id(), DEFAULT_BUFFER_CAPACITY));
        let start = origin.url("/start");
        run_inner(Arc::clone(&state), post_plan(&start, b"hello"), key, client).await;

        let head = state.headers().await.expect("final response arrives");
        assert_eq!(head.status, 200);
        assert!(head.redirected);
        assert_eq!(state.read(64).await.expect("body"), Some(b"GET:0".to_vec()));
        restore_proxy_env(previous_env);
    }

    /// Authorization is stripped on a cross-origin hop and kept on a
    /// same-origin hop.
    #[tokio::test]
    async fn redirect_strips_authorization_only_cross_origin() {
        let _serial = FALLBACK_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();

        let echo_auth = |_method: &str, _body: &str, head: &str| {
            let present = head
                .lines()
                .any(|line| line.to_ascii_lowercase().starts_with("authorization:"));
            raw_response(
                "200 OK",
                &[],
                if present {
                    "auth:present"
                } else {
                    "auth:absent"
                },
            )
        };

        let other = crate::testsupport::spawn_http_server(echo_auth);
        let other_url = other.url("/other");
        let cross_origin = crate::testsupport::spawn_http_server(move |_method, _body, _head| {
            raw_response("302 Found", &[("Location", &other_url)], "")
        });

        let key = default_key();
        let client = runtime::client_for(key).expect("default client builds");
        let state = Arc::new(RequestState::new(next_id(), DEFAULT_BUFFER_CAPACITY));
        let plan = RequestPlan {
            method: Method::GET,
            url: Url::parse(&cross_origin.url("/start")).expect("url parses"),
            headers: vec![(
                HeaderName::from_static("authorization"),
                HeaderValue::from_static("Bearer secret"),
            )],
            body: None,
        };
        run_inner(Arc::clone(&state), plan, key, client).await;
        state.headers().await.expect("response arrives");
        assert_eq!(
            state.read(64).await.expect("body"),
            Some(b"auth:absent".to_vec()),
            "a cross-origin redirect must drop Authorization"
        );

        // Same origin (same host and port, different path) keeps the header.
        let same_origin = crate::testsupport::spawn_http_server(move |_method, _body, head| {
            if head.starts_with("GET /start ") {
                raw_response("302 Found", &[("Location", "/final")], "")
            } else {
                echo_auth("GET", "", head)
            }
        });

        let client = runtime::client_for(key).expect("default client builds");
        let state = Arc::new(RequestState::new(next_id(), DEFAULT_BUFFER_CAPACITY));
        let plan = RequestPlan {
            method: Method::GET,
            url: Url::parse(&same_origin.url("/start")).expect("url parses"),
            headers: vec![(
                HeaderName::from_static("authorization"),
                HeaderValue::from_static("Bearer secret"),
            )],
            body: None,
        };
        run_inner(Arc::clone(&state), plan, key, client).await;
        state.headers().await.expect("response arrives");
        assert_eq!(
            state.read(64).await.expect("body"),
            Some(b"auth:present".to_vec()),
            "a same-origin redirect must keep Authorization"
        );
        restore_proxy_env(previous_env);
    }

    /// The hop limit matches reqwest's former `Policy::limited(20)`: the 21st
    /// redirect is an error, so at most 21 requests are sent.
    #[tokio::test]
    async fn redirect_limit_stops_after_twenty_hops() {
        let _serial = FALLBACK_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();
        let server = crate::testsupport::spawn_http_server(|_method, _body, _head| {
            raw_response("302 Found", &[("Location", "/loop")], "")
        });

        let key = default_key();
        let client = runtime::client_for(key).expect("default client builds");
        let state = Arc::new(RequestState::new(next_id(), DEFAULT_BUFFER_CAPACITY));
        let plan = test_plan(&server.url("/loop"));
        run_inner(Arc::clone(&state), plan, key, client).await;

        let error = state.headers().await.expect_err("the loop must fail");
        assert!(
            error.contains("too many redirects"),
            "unexpected error: {error}"
        );
        assert_eq!(server.request_count(), 21);
        restore_proxy_env(previous_env);
    }
}
