//! Explicit, immutable TLS profiles registered through `configureTls`.
//!
//! Profile `0` is reserved for the default platform-trust client (stage-1
//! behavior) and is never created here. Ids are monotonic and a profile is
//! append-only once registered: the TypeScript layer caches the id per
//! configuration fingerprint and expects the same id to keep the same trust
//! material for the life of the process.
//!
//! Validation happens at registration time, not at request time, so a bad PEM
//! or an unusable proxy URL surfaces as one clear `InvalidArg` on the
//! `configureTls` call instead of a per-request connect failure.
//!
//! The root/identity API shape (`Certificate::from_pem_bundle`,
//! `Identity::from_pem`, identity-requires-both-halves) is adapted from
//! /Volumes/workspace/codex-upstream-main/codex-rs/http-client/src/client_tls.rs
//! (Apache-2.0, Copyright OpenAI).

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use rustls_pki_types::ServerName;

/// One registered profile. Never mutated after `configure` returns.
pub struct TlsProfile {
    pub id: u32,
    /// PEM bundle merged into the platform trust store for this profile.
    pub ca_pem: Option<String>,
    /// Client certificate chain and private key, concatenated in one PEM.
    pub identity_pem: Option<String>,
    /// `false` only when the caller explicitly disabled verification.
    pub reject_unauthorized: bool,
    /// Verification name override for the TLS handshake.
    pub server_name: Option<String>,
    /// Explicit proxy pinned to this profile; such a profile never falls back
    /// to a direct connection.
    pub proxy: Option<String>,
}

impl TlsProfile {
    /// Profile 0: platform trust, env extra roots, system proxy, verification on.
    fn default_profile() -> Self {
        Self {
            id: 0,
            ca_pem: None,
            identity_pem: None,
            reject_unauthorized: true,
            server_name: None,
            proxy: None,
        }
    }

    /// A pinned proxy always means `ProxyMode::Pinned`, so route fallback can
    /// never silently bypass the operator's explicit choice.
    pub fn has_pinned_proxy(&self) -> bool {
        self.proxy.is_some()
    }
}

/// Plain-Rust description of one `configureTls` call.
pub struct ProfileSpec {
    pub ca_pem: Option<String>,
    pub cert_pem: Option<String>,
    pub key_pem: Option<String>,
    pub reject_unauthorized: Option<bool>,
    pub server_name: Option<String>,
    pub proxy: Option<String>,
}

static PROFILES: OnceLock<Mutex<Vec<Arc<TlsProfile>>>> = OnceLock::new();

fn registry() -> &'static Mutex<Vec<Arc<TlsProfile>>> {
    PROFILES.get_or_init(|| Mutex::new(vec![Arc::new(TlsProfile::default_profile())]))
}

fn registry_lock() -> MutexGuard<'static, Vec<Arc<TlsProfile>>> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Register one immutable profile and return its monotonic id.
pub fn configure(spec: ProfileSpec) -> Result<u32, String> {
    let identity_pem = match (spec.cert_pem, spec.key_pem) {
        (None, None) => None,
        (Some(_), None) => {
            return Err("tls profile: a client certificate requires a private key".to_string())
        }
        (None, Some(_)) => {
            return Err("tls profile: a private key requires a client certificate".to_string())
        }
        (Some(mut cert), Some(key)) => {
            if !cert.ends_with('\n') {
                cert.push('\n');
            }
            cert.push_str(&key);
            // Parsing here (rather than at request time) proves the chain and
            // key are usable together.
            reqwest::Identity::from_pem(cert.as_bytes())
                .map_err(|error| format!("tls profile: invalid client identity PEM: {error}"))?;
            Some(cert)
        }
    };

    if let Some(ca) = &spec.ca_pem {
        let certs = reqwest::Certificate::from_pem_bundle(ca.as_bytes())
            .map_err(|error| format!("tls profile: invalid CA PEM: {error}"))?;
        if certs.is_empty() {
            return Err("tls profile: CA PEM contains no certificates".to_string());
        }
    }

    if let Some(server_name) = &spec.server_name {
        ServerName::try_from(server_name.clone()).map_err(|error| {
            format!("tls profile: invalid server name `{server_name}`: {error}")
        })?;
    }

    if let Some(proxy) = &spec.proxy {
        let url = reqwest::Url::parse(proxy)
            .map_err(|error| format!("tls profile: invalid proxy url `{proxy}`: {error}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!(
                "tls profile: unsupported proxy scheme `{}`: use http:// or https://",
                url.scheme()
            ));
        }
    }

    let mut profiles = registry_lock();
    let id = profiles.len() as u32;
    profiles.push(Arc::new(TlsProfile {
        id,
        ca_pem: spec.ca_pem,
        identity_pem,
        // Only an explicit `false` disables verification; absent means on.
        reject_unauthorized: spec.reject_unauthorized.unwrap_or(true),
        server_name: spec.server_name,
        proxy: spec.proxy,
    }));
    Ok(id)
}

/// Look up a registered profile. `None` means the caller passed an id that was
/// never registered (or a profile registered by a different process).
pub fn get(id: u32) -> Option<Arc<TlsProfile>> {
    registry_lock().get(id as usize).cloned()
}

/// Number of registered profiles including the reserved default.
#[cfg(test)]
pub fn count() -> usize {
    registry_lock().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real self-signed cert PEM (openssl-generated, CN=testca); also used by
    /// the `tls` module's parse tests.
    const TEST_CERT_PEM: &str = "\
-----BEGIN CERTIFICATE-----
MIIB3TCCAUagAwIBAgIUJRXvZ62cPGMQIu84HTSPUlGG++0wDQYJKoZIhvcNAQEL
BQAwETEPMA0GA1UEAwwGdGVzdGNhMB4XDTI2MTEyMDA2MTgwMVoXDTM2MTExNzA2
MTgwMVowETEPMA0GA1UEAwwGdGVzdGNhMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCB
iQKBgQDZGOmlyno+2ODJKjjqwYa4s6W9ZqCfjSTa+wTjC1OAZoGFnEqCc7pqxL/t
p8JK1jz3hcosrmRCxdDpolmef22/24TUrTsvvtxLMnldbxGElZs2cesN85tI7Etb
3XgG7vyz59fYXQc2me6/rGl/dvhz0+rHH/Wih/DpTN6u/gJ03QIDAQABozIwMDAd
BgNVHQ4EFgQUd6adAw3EH4xWaBtXRYXTVcdFtCIwDwYDVR0TAQH/BAUwAwEB/zAN
BgkqhkiG9w0BAQsFAAOBgQDSjYiOO/iWsfp4RHbrSv0CKlG7xaPMEVtDAK/EMT1r
B7qtjnaseOJTEzsSSwqT8HoTayZv6WDSYHo1u9KjU51OCI0x5AuUy/k8oo3AgzE9
z2LTxfzxl3t1Ig5mjfBJH1inloJSrKDgM58r/iA4KfK59RJByl1JfNG23IJPF7pN
Sw==
-----END CERTIFICATE-----
";

    fn spec() -> ProfileSpec {
        ProfileSpec {
            ca_pem: None,
            cert_pem: None,
            key_pem: None,
            reject_unauthorized: None,
            server_name: None,
            proxy: None,
        }
    }

    #[test]
    fn ids_are_monotonic_and_zero_is_reserved_for_the_default() {
        let before = count();
        let first = configure(spec()).expect("profile registers");
        let second = configure(spec()).expect("profile registers");

        assert_eq!(first as usize, before);
        assert_eq!(second, first + 1);
        assert!(first >= 1, "id 0 is reserved for the default profile");
        assert_eq!(get(0).expect("default exists").id, 0);
        assert!(get(0).expect("default exists").reject_unauthorized);
        assert!(get(second).is_some());
    }

    #[test]
    fn registered_profiles_are_immutable_snapshots() {
        let mut first = spec();
        first.server_name = Some("first.test".to_string());
        let id = configure(first).expect("profile registers");

        let mut second = spec();
        second.server_name = Some("second.test".to_string());
        configure(second).expect("profile registers");

        assert_eq!(
            get(id).expect("profile exists").server_name.as_deref(),
            Some("first.test")
        );
    }

    #[test]
    fn certificate_without_key_is_rejected() {
        let mut only_cert = spec();
        only_cert.cert_pem = Some(TEST_CERT_PEM.to_string());
        let error = configure(only_cert).expect_err("cert without key is invalid");
        assert!(error.contains("requires a private key"));
    }

    #[test]
    fn key_without_certificate_is_rejected() {
        let mut only_key = spec();
        only_key.key_pem =
            Some("-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n".to_string());
        let error = configure(only_key).expect_err("key without cert is invalid");
        assert!(error.contains("requires a client certificate"));
    }

    #[test]
    fn malformed_ca_pem_is_rejected() {
        let mut bad_ca = spec();
        bad_ca.ca_pem = Some("not a pem".to_string());
        let error = configure(bad_ca).expect_err("garbage CA PEM is invalid");
        assert!(error.contains("CA PEM"), "unexpected error: {error}");
    }

    #[test]
    fn non_http_proxy_url_is_rejected() {
        let mut bad_proxy = spec();
        bad_proxy.proxy = Some("socks5://127.0.0.1:1080".to_string());
        let error = configure(bad_proxy).expect_err("unsupported proxy scheme");
        assert!(error.contains("unsupported proxy scheme"));
    }

    #[test]
    fn proxy_url_is_retained_as_the_pinned_route() {
        let mut pinned = spec();
        pinned.proxy = Some("http://127.0.0.1:8080".to_string());
        let id = configure(pinned).expect("profile registers");
        let profile = get(id).expect("profile exists");
        assert!(profile.has_pinned_proxy());
        assert_eq!(profile.proxy.as_deref(), Some("http://127.0.0.1:8080"));
    }

    #[test]
    fn invalid_server_name_is_rejected() {
        let mut bad_name = spec();
        bad_name.server_name = Some("not a dns name".to_string());
        let error = configure(bad_name).expect_err("invalid server name");
        assert!(error.contains("invalid server name"));
    }
}
