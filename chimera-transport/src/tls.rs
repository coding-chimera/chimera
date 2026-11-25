//! TLS trust configuration for the single shared reqwest client.
//!
//! Trust model:
//!
//!   * profile 0 (the default client) uses the OS trust store through
//!     rustls-platform-verifier (Security.framework on macOS, the native
//!     pemfile/openssl-probe paths on Linux). Extra roots supplied through
//!     [`default_trust_config`] are ADDITIVE: the primary verifier is
//!     `Verifier::new_with_extra_roots`, and because the platform verifier
//!     enforces platform policy (macOS, for example, rejects a TLS leaf whose
//!     validity period exceeds Apple's limit even when its CA is explicitly
//!     trusted), a second verifier built from the extra roots ALONE is tried
//!     when the platform verifier rejects the chain. The OS store is never
//!     replaced, and the fallback can only trust the explicit extra roots, so
//!     default-deny for every other certificate is unchanged.
//!   * if the platform verifier cannot be constructed (locked-down containers,
//!     missing OS stores), the client build falls back to a bundled
//!     webpki-roots [`rustls::ClientConfig`] handed to reqwest through
//!     `use_preconfigured_tls`. The fallback is logged on stderr, not silent.
//!
//! Env roots are harvested EXACTLY ONCE, at module init ([`init`]):
//! `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS` and
//! `OPENCODE_RUST_TRANSPORT_CA_FILE`. Changing any of them requires a process
//! restart to take effect — the shared client is built once and cached.
//!
//! PEM parsing robustness (OpenSSL `TRUSTED CERTIFICATE` label normalization
//! plus trailing `X509_AUX` trimming, CRL sections ignored) is adapted from
//! /Volumes/workspace/codex-upstream-main/codex-rs/http-client/src/custom_ca.rs
//! (Apache-2.0, Copyright OpenAI). The crypto-provider install with the
//! ECDSA P-521 support assertion is adapted from
//! /Volumes/workspace/codex-upstream-main/codex-rs/utils/rustls-provider/src/lib.rs
//! (Apache-2.0, Copyright OpenAI).

use std::path::Path;
use std::sync::{Arc, Once, OnceLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use rustls_pki_types::pem::{self, PemObject, SectionKind};

use crate::profile::TlsProfile;

/// OpenSSL-style CA bundle override understood by Node/Bun ecosystems.
const NODE_EXTRA_CA_CERTS_ENV: &str = "NODE_EXTRA_CA_CERTS";
/// Chimera-specific CA bundle override; wins nothing, merges like the rest.
const TRANSPORT_CA_FILE_ENV: &str = "OPENCODE_RUST_TRANSPORT_CA_FILE";
/// OpenSSL convention: single PEM bundle file.
const SSL_CERT_FILE_ENV: &str = "SSL_CERT_FILE";
/// OpenSSL convention: colon-separated list of hashed-cert directories.
const SSL_CERT_DIR_ENV: &str = "SSL_CERT_DIR";

/// ECDSA P-521/SHA-512 certs are used by some enterprise TLS proxies; ring
/// does not verify them, aws-lc-rs does. The provider install asserts support
/// so a future provider swap cannot silently drop it.
const REQUIRED_SIGNATURE_SCHEME: rustls::SignatureScheme =
    rustls::SignatureScheme::ECDSA_NISTP521_SHA512;

/// Env-harvested extra roots, in DER — the shape every verifier here wants.
struct ExtraRoots {
    der: Vec<CertificateDer<'static>>,
}

static EXTRA_ROOTS: OnceLock<ExtraRoots> = OnceLock::new();

/// One-time TLS initialization, called from `runtime::init()` (module_init):
/// installs the process-wide rustls crypto provider BEFORE any `reqwest`
/// Client is built (reqwest panics building a rustls client with no provider
/// available), then harvests the env roots so later env mutations cannot
/// change trust mid-process.
pub fn init() {
    ensure_crypto_provider();
    let _ = extra_roots();
}

/// Ensures a process-wide rustls crypto provider is installed.
///
/// rustls cannot auto-select a provider when both `ring` and `aws-lc-rs`
/// features are enabled anywhere in the dependency graph.
///
/// Adapted from codex-rs/utils/rustls-provider/src/lib.rs (Apache-2.0).
pub fn ensure_crypto_provider() {
    static PROVIDER_INIT: Once = Once::new();
    PROVIDER_INIT.call_once(|| {
        // aws-lc-rs supports a broader WebPKI signature set than ring,
        // including ECDSA P-521/SHA-512 certs used by some enterprise proxies.
        if rustls::crypto::aws_lc_rs::default_provider()
            .install_default()
            .is_err()
        {
            // Preserve best-effort behavior for embedded hosts that install a
            // process-global provider before this addon can install one.
            return;
        }

        let Some(provider) = rustls::crypto::CryptoProvider::get_default() else {
            panic!("aws-lc-rs rustls crypto provider should be installed");
        };
        assert!(
            provider
                .signature_verification_algorithms
                .supported_schemes()
                .contains(&REQUIRED_SIGNATURE_SCHEME),
            "installed rustls crypto provider must support {REQUIRED_SIGNATURE_SCHEME:?}"
        );
    });
}

/// Client TLS config for the default (profile 0) client when env extra roots
/// are present: OS platform trust PLUS those roots, additively.
///
/// The platform verifier stays primary so the OS store and its policy remain
/// in force. It is combined with a verifier built from the extra roots only,
/// tried when the platform verifier rejects the chain — on macOS the platform
/// verifier enforces Apple's certificate policy (e.g. its validity-period
/// limit) even for a CA the caller explicitly supplied, which would otherwise
/// make `caPem`/env-root trust unusable for long-lived enterprise or test
/// certificates. The secondary verifier cannot trust anything outside the
/// explicit extra roots, so no platform-trusted chain becomes reachable
/// through it.
pub fn default_trust_config(http1_only: bool) -> Result<rustls::ClientConfig, String> {
    default_trust_config_with(&extra_roots().der, http1_only)
}

/// [`default_trust_config`] with an explicit root list; the seam exists so
/// tests can exercise the additive wiring without the process-wide env cache.
pub fn default_trust_config_with(
    extra_roots: &[CertificateDer<'static>],
    http1_only: bool,
) -> Result<rustls::ClientConfig, String> {
    let crypto = provider();
    let verifier = additive_verifier(extra_roots, Arc::clone(&crypto))?;
    let mut config = ClientConfig::builder_with_provider(crypto)
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("failed to configure TLS versions: {error}"))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.alpn_protocols = alpn(http1_only);
    Ok(config)
}

/// True when at least one env CA source produced roots. Used to keep the
/// untouched reqwest default path when there is nothing to add.
pub fn has_extra_roots() -> bool {
    !extra_roots().der.is_empty()
}

/// The webpki-roots fallback `ClientConfig`, used only when the default
/// platform-verifier client build fails. Includes the env extra roots and —
/// because `use_preconfigured_tls` bypasses reqwest's own ALPN wiring — an
/// explicit ALPN list: an empty `alpn_protocols` on a preconfigured config
/// would silently disable HTTP/2 (the Zed trap). A `http1_only` client
/// advertises `http/1.1` alone, because advertising h2 to a client that
/// cannot speak it would let the server pick a protocol the client rejects.
pub fn webpki_fallback_config(http1_only: bool) -> rustls::ClientConfig {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for cert in &extra_roots().der {
        if let Err(error) = roots.add(cert.clone()) {
            eprintln!("chimera-transport: env root rejected by the webpki fallback store: {error}");
        }
    }

    let mut config = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("safe default TLS protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = alpn(http1_only);
    config
}

/// Verifier that keeps OS platform trust as the primary decision and adds a
/// second, explicit-extra-roots-only verifier as a fallback.
///
/// This exists because `rustls-platform-verifier` cannot merge extra roots on
/// every platform the way callers expect: on macOS `SecTrust` enforces Apple's
/// certificate policy (for example the 398-day TLS leaf validity limit) even
/// when the issuing CA was passed as an extra anchor, so `tls_certs_merge`
/// alone silently fails for long-lived enterprise/test CAs. The fallback below
/// trusts ONLY the caller-supplied extra roots, so it never widens trust to a
/// platform root the OS would have rejected, and a chain not anchored in the
/// extra roots still fails default-deny.
fn additive_verifier(
    extra_roots: &[CertificateDer<'static>],
    crypto: Arc<CryptoProvider>,
) -> Result<Arc<dyn ServerCertVerifier>, String> {
    let platform = rustls_platform_verifier::Verifier::new_with_extra_roots(
        extra_roots.iter().cloned(),
        Arc::clone(&crypto),
    )
    .map_err(|error| format!("failed to build the platform TLS verifier: {error}"))?;

    let extra_only: Option<Arc<dyn ServerCertVerifier>> = if extra_roots.is_empty() {
        None
    } else {
        let mut roots = RootCertStore::empty();
        for cert in extra_roots {
            roots
                .add(cert.clone())
                .map_err(|error| format!("extra root rejected: {error}"))?;
        }
        let webpki =
            WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::clone(&crypto))
                .build()
                .map_err(|error| {
                    format!("failed to build the extra-roots TLS verifier: {error}")
                })?;
        Some(webpki)
    };

    Ok(Arc::new(AdditiveRootsVerifier {
        platform: Arc::new(platform),
        extra_only,
        crypto,
    }))
}

/// Platform-first verifier with an explicit-extra-roots fallback. See
/// [`additive_verifier`].
#[derive(Debug)]
struct AdditiveRootsVerifier {
    platform: Arc<dyn ServerCertVerifier>,
    extra_only: Option<Arc<dyn ServerCertVerifier>>,
    crypto: Arc<CryptoProvider>,
}

impl ServerCertVerifier for AdditiveRootsVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.platform.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(verified) => Ok(verified),
            Err(platform_error) => match &self.extra_only {
                Some(verifier) => verifier.verify_server_cert(
                    end_entity,
                    intermediates,
                    server_name,
                    ocsp_response,
                    now,
                ),
                None => Err(platform_error),
            },
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.crypto.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.crypto.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.crypto
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// TLS configuration for an explicit profile (`serverName` override, a pinned
/// CA bundle, or `rejectUnauthorized: false`).
///
/// Without a name override the verifier is [`additive_verifier`]: OS platform
/// trust stays primary and the env extra roots plus the profile's `caPem` are
/// added. With a name override the platform verifier cannot be used (it has no
/// hook to verify a different name), so that path trusts bundled webpki roots +
/// env extra roots + the profile CA.
///
/// Every returned config sets a non-empty ALPN list for the same Zed-trap
/// reason as [`webpki_fallback_config`].
pub fn preconfigured_profile_config(
    profile: &TlsProfile,
    http1_only: bool,
) -> Result<rustls::ClientConfig, String> {
    let crypto = provider();
    let verifier: Arc<dyn ServerCertVerifier> = if !profile.reject_unauthorized {
        Arc::new(NoCertificateVerification::new(crypto))
    } else {
        match &profile.server_name {
            // A name override needs a verifier that checks that name; the
            // platform verifier has no such hook, so this path trusts the
            // bundled webpki roots + env extra roots + the profile CA.
            Some(name) => {
                let roots = profile_root_store(profile)?;
                let webpki = WebPkiServerVerifier::builder_with_provider(
                    Arc::new(roots),
                    Arc::clone(&crypto),
                )
                .build()
                .map_err(|error| format!("failed to build the TLS verifier: {error}"))?;
                let name = ServerName::try_from(name.clone())
                    .map_err(|error| format!("invalid server name: {error}"))?;
                Arc::new(NameOverrideVerifier {
                    inner: webpki,
                    name,
                })
            }
            // No name override: keep OS platform trust AND add env extra
            // roots plus the profile CA, additively (see `additive_verifier`).
            None => additive_verifier(&profile_extra_roots(profile)?, Arc::clone(&crypto))?,
        }
    };

    let builder = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("failed to configure TLS versions: {error}"))?
        .dangerous()
        .with_custom_certificate_verifier(verifier);

    let mut config = match &profile.identity_pem {
        Some(pem) => {
            let certs = CertificateDer::pem_slice_iter(pem.as_bytes())
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("invalid client certificate PEM: {error}"))?;
            let key = PrivateKeyDer::pem_slice_iter(pem.as_bytes())
                .last()
                .transpose()
                .map_err(|error| format!("invalid client key PEM: {error}"))?
                .ok_or_else(|| "client identity PEM is missing a private key".to_string())?;
            builder
                .with_client_auth_cert(certs, key)
                .map_err(|error| format!("invalid client identity: {error}"))?
        }
        None => builder.with_no_client_auth(),
    };
    config.alpn_protocols = alpn(http1_only);
    Ok(config)
}

/// The process crypto provider, with the aws-lc-rs default as the backstop so
/// config construction cannot panic before [`init`] ran.
fn provider() -> Arc<CryptoProvider> {
    CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
}

/// Explicit, non-empty ALPN list. Never leave this empty on a preconfigured
/// config: an empty list silently disables HTTP/2 negotiation.
fn alpn(http1_only: bool) -> Vec<Vec<u8>> {
    if http1_only {
        vec![b"http/1.1".to_vec()]
    } else {
        vec![b"h2".to_vec(), b"http/1.1".to_vec()]
    }
}

/// Roots for the name-override path: bundled webpki roots plus the env extra
/// roots and the profile's own CA bundle.
fn profile_root_store(profile: &TlsProfile) -> Result<RootCertStore, String> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for cert in profile_extra_roots(profile)? {
        if let Err(error) = roots.add(cert) {
            eprintln!("chimera-transport: extra root rejected by the profile store: {error}");
        }
    }
    Ok(roots)
}

/// Env extra roots plus the profile's own CA bundle, in DER.
fn profile_extra_roots(profile: &TlsProfile) -> Result<Vec<CertificateDer<'static>>, String> {
    let mut roots = extra_roots().der.clone();
    if let Some(ca) = &profile.ca_pem {
        for cert in CertificateDer::pem_slice_iter(ca.as_bytes()) {
            roots.push(cert.map_err(|error| format!("invalid CA PEM: {error}"))?);
        }
    }
    Ok(roots)
}

/// Verifies against `name` instead of the host reqwest passes in, so a
/// `serverName` profile can trust a certificate issued for a different DNS
/// name. SNI still follows the request URL (reqwest derives it from the
/// connection host and exposes no override).
#[derive(Debug)]
struct NameOverrideVerifier {
    inner: Arc<dyn ServerCertVerifier>,
    name: ServerName<'static>,
}

impl ServerCertVerifier for NameOverrideVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.inner
            .verify_server_cert(end_entity, intermediates, &self.name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Accepts every certificate. Reachable only from a profile that explicitly
/// set `rejectUnauthorized: false`; never a global or env default.
#[derive(Debug)]
struct NoCertificateVerification {
    schemes: Vec<SignatureScheme>,
}

impl NoCertificateVerification {
    fn new(provider: Arc<CryptoProvider>) -> Self {
        Self {
            schemes: provider
                .signature_verification_algorithms
                .supported_schemes(),
        }
    }
}

impl ServerCertVerifier for NoCertificateVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.schemes.clone()
    }
}
fn extra_roots() -> &'static ExtraRoots {
    EXTRA_ROOTS.get_or_init(|| ExtraRoots {
        der: harvest_env_roots(),
    })
}

/// Reads every configured env source once and merges the results. Unreadable
/// or empty sources degrade to zero certs with a stderr note — a misconfigured
/// CA file must not take the whole transport down at module init.
fn harvest_env_roots() -> Vec<CertificateDer<'static>> {
    let mut certs = Vec::new();

    if let Some(path) = non_empty_env_path(SSL_CERT_FILE_ENV) {
        let result = rustls_native_certs::load_certs_from_paths(Some(&path), None);
        report_native_certs(SSL_CERT_FILE_ENV, &path, &result);
        certs.extend(result.certs);
    }

    if let Some(raw) = non_empty_env(SSL_CERT_DIR_ENV) {
        for dir in raw
            .split(':')
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            let path = Path::new(dir);
            let result = rustls_native_certs::load_certs_from_paths(None, Some(path));
            report_native_certs(SSL_CERT_DIR_ENV, path, &result);
            certs.extend(result.certs);
        }
    }

    for env in [NODE_EXTRA_CA_CERTS_ENV, TRANSPORT_CA_FILE_ENV] {
        if let Some(path) = non_empty_env_path(env) {
            certs.extend(pem_file_roots(env, &path));
        }
    }

    certs
}

fn report_native_certs(env: &str, path: &Path, result: &rustls_native_certs::CertificateResult) {
    if result.certs.is_empty() {
        eprintln!(
            "chimera-transport: {env}={} yielded no certificates ({})",
            path.display(),
            result
                .errors
                .first()
                .map(ToString::to_string)
                .unwrap_or_else(|| "no parseable PEM blocks".to_string())
        );
    }
    for error in &result.errors {
        eprintln!("chimera-transport: {env}: skipped an unreadable entry: {error}");
    }
}

/// Parses every certificate block from one PEM file, accepting the common
/// real-world variants: OpenSSL `TRUSTED CERTIFICATE` labels are normalized
/// (their trailing `X509_AUX` trust metadata trimmed) and embedded CRL
/// sections are ignored.
///
/// Adapted from codex-rs/http-client/src/custom_ca.rs (Apache-2.0).
fn pem_file_roots(env: &str, path: &Path) -> Vec<CertificateDer<'static>> {
    let Ok(data) = std::fs::read(path) else {
        eprintln!(
            "chimera-transport: cannot read the CA bundle {} selected by {env}; \
             ensure it points to a PEM file with CERTIFICATE blocks, or unset it",
            path.display()
        );
        return Vec::new();
    };

    let raw = String::from_utf8_lossy(&data);
    let trusted_variant = raw.contains("TRUSTED CERTIFICATE");
    let normalized = if trusted_variant {
        raw.replace("BEGIN TRUSTED CERTIFICATE", "BEGIN CERTIFICATE")
            .replace("END TRUSTED CERTIFICATE", "END CERTIFICATE")
    } else {
        raw.into_owned()
    };

    let mut certs = Vec::new();
    for section in <(SectionKind, Vec<u8>)>::pem_slice_iter(normalized.as_bytes()) {
        match section {
            Ok((SectionKind::Certificate, der)) => {
                // Standard CERTIFICATE blocks decode to the exact DER wanted.
                // Only TRUSTED CERTIFICATE blocks may append X509_AUX trust
                // metadata that must be trimmed to the first DER object.
                let trimmed = trusted_variant
                    .then(|| first_der_item(&der))
                    .flatten()
                    .map(ToOwned::to_owned)
                    .unwrap_or(der);
                certs.push(CertificateDer::from(trimmed));
            }
            // CRLs and any other section kinds are ignored on purpose.
            Ok(_) => {}
            Err(error) => {
                eprintln!(
                    "chimera-transport: {env}: malformed PEM section in {}: {error}",
                    path.display()
                );
            }
        }
    }

    if certs.is_empty() {
        eprintln!(
            "chimera-transport: {env}: no certificates found in {} ({})",
            path.display(),
            pem_hint(&pem::Error::NoItemsFound)
        );
    }
    certs
}

fn pem_hint(error: &pem::Error) -> String {
    match error {
        pem::Error::NoItemsFound => "no certificates found in PEM file".to_string(),
        other => format!("failed to parse PEM file: {other}"),
    }
}

/// Returns the first DER-encoded ASN.1 object in `der`, ignoring trailing
/// OpenSSL `X509_AUX` metadata. Only the outer tag/length header is parsed —
/// the real certificate validation happens later in rustls.
///
/// Adapted from codex-rs/http-client/src/custom_ca.rs (Apache-2.0).
fn first_der_item(der: &[u8]) -> Option<&[u8]> {
    der_item_length(der).map(|length| &der[..length])
}

fn der_item_length(der: &[u8]) -> Option<usize> {
    let &length_octet = der.get(1)?;
    if length_octet & 0x80 == 0 {
        return Some(2 + usize::from(length_octet)).filter(|length| *length <= der.len());
    }

    let length_octets = usize::from(length_octet & 0x7f);
    if length_octets == 0 {
        return None;
    }

    let length_start = 2usize;
    let length_end = length_start.checked_add(length_octets)?;
    let length_bytes = der.get(length_start..length_end)?;
    let mut content_length = 0usize;
    for &byte in length_bytes {
        content_length = content_length
            .checked_mul(256)?
            .checked_add(usize::from(byte))?;
    }

    length_end
        .checked_add(content_length)
        .filter(|length| *length <= der.len())
}

/// Non-empty env value; `VAR=""` counts as unset so it never turns into a
/// bogus path lookup.
fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn non_empty_env_path(key: &str) -> Option<std::path::PathBuf> {
    non_empty_env(key).map(std::path::PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real self-signed cert PEM (openssl-generated, CN=testca) used as the
    /// parse fixture; its DER content is opaque to the parser under test.
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

    #[test]
    fn der_item_length_parses_short_form() {
        let der = [0x30, 0x03, 0x01, 0x02, 0x03];
        assert_eq!(der_item_length(&der), Some(5));
    }

    #[test]
    fn der_item_length_parses_long_form_and_trims_trailer() {
        // Tag, long-form length 0x81 0x80 (= 128 content bytes), content,
        // then two trailing X509_AUX bytes that must be excluded.
        let mut der = vec![0x30, 0x81, 0x80];
        der.extend(std::iter::repeat_n(0xAA, 128));
        der.extend([0xFF, 0xFF]);
        assert_eq!(der_item_length(&der), Some(131));
        assert_eq!(first_der_item(&der).map(<[u8]>::len), Some(131));
    }

    #[test]
    fn der_item_length_rejects_indefinite_and_overlong() {
        assert_eq!(der_item_length(&[0x30, 0x80]), None);
        assert_eq!(der_item_length(&[0x30, 0x09, 0x01]), None);
        assert_eq!(der_item_length(&[0x30]), None);
    }

    #[test]
    fn pem_file_roots_parses_standard_certificate() {
        let dir =
            std::env::temp_dir().join(format!("chimera-transport-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("standard.pem");
        std::fs::write(&path, TEST_CERT_PEM).unwrap();
        let certs = pem_file_roots("TEST_ENV", &path);
        assert_eq!(certs.len(), 1);
        assert!(!certs[0].as_ref().is_empty());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn pem_file_roots_normalizes_trusted_certificate_labels() {
        let dir =
            std::env::temp_dir().join(format!("chimera-transport-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trusted.pem");
        let trusted = TEST_CERT_PEM
            .replace("BEGIN CERTIFICATE", "BEGIN TRUSTED CERTIFICATE")
            .replace("END CERTIFICATE", "END TRUSTED CERTIFICATE");
        std::fs::write(&path, trusted).unwrap();
        let certs = pem_file_roots("TEST_ENV", &path);
        assert_eq!(certs.len(), 1);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn pem_file_roots_empty_for_missing_or_blank_file() {
        let dir =
            std::env::temp_dir().join(format!("chimera-transport-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let blank = dir.join("blank.pem");
        std::fs::write(&blank, "").unwrap();
        assert!(pem_file_roots("TEST_ENV", &blank).is_empty());
        assert!(pem_file_roots("TEST_ENV", &dir.join("missing.pem")).is_empty());
        std::fs::remove_file(&blank).unwrap();
    }

    #[test]
    fn webpki_fallback_config_carries_h2_alpn() {
        ensure_crypto_provider();
        let config = webpki_fallback_config(false);
        assert_eq!(
            config.alpn_protocols,
            vec![b"h2".to_vec(), b"http/1.1".to_vec()]
        );
        assert!(config.enable_sni);
    }

    #[test]
    fn webpki_fallback_config_for_http1_advertises_only_http1() {
        ensure_crypto_provider();
        let config = webpki_fallback_config(true);
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn preconfigured_profile_config_always_sets_alpn() {
        ensure_crypto_provider();
        let profile = TlsProfile {
            id: 1,
            ca_pem: None,
            identity_pem: None,
            reject_unauthorized: false,
            server_name: None,
            proxy: None,
        };
        let config = preconfigured_profile_config(&profile, false).expect("config builds");
        assert_eq!(
            config.alpn_protocols,
            vec![b"h2".to_vec(), b"http/1.1".to_vec()]
        );

        let http1 = preconfigured_profile_config(&profile, true).expect("config builds");
        assert_eq!(http1.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    /// Env mutation and process-global trust setup must not interleave.
    static ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const PROXY_ENV: [&str; 6] = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ];

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

    fn restore_env(previous: Vec<(&'static str, Option<String>)>) {
        for (key, value) in previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    const OK_RESPONSE: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

    fn ok_server() -> crate::testsupport::TestServer {
        crate::testsupport::spawn_tls_server(|_, _, _| OK_RESPONSE.to_string())
    }

    /// BUG #5 regression: a `caPem`-only profile (no `serverName`) must trust a
    /// server signed by that CA. The fixture leaf is deliberately long-lived,
    /// which is exactly where `tls_certs_merge` + the platform verifier fails on
    /// macOS (Apple's validity-period policy rejects it even though the CA is
    /// explicitly trusted).
    #[tokio::test]
    async fn ca_pem_only_profile_trusts_a_ca_signed_server() {
        let _serial = ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();
        ensure_crypto_provider();
        let server = ok_server();

        let id = crate::profile::configure(crate::profile::ProfileSpec {
            ca_pem: Some(crate::testsupport::CA_PEM.to_string()),
            cert_pem: None,
            key_pem: None,
            reject_unauthorized: None,
            server_name: None,
            proxy: None,
        })
        .expect("profile registers");
        let key = crate::runtime::ClientKey {
            profile_id: id,
            http_version: crate::runtime::HttpVersion::Auto,
            proxy_mode: crate::runtime::ProxyMode::Auto,
        };
        let client = crate::runtime::client_for(key).expect("profile client builds");
        let response = client
            .get(server.https_url("/ca-pem-only"))
            .send()
            .await
            .expect("a profile that pins a CA must trust a server signed by it");
        assert_eq!(response.status(), 200);
        assert_eq!(server.request_count(), 1);
        restore_env(previous_env);
    }

    /// BUG #5 regression: every env CA source feeds profile 0's additive trust.
    #[tokio::test]
    async fn every_env_root_source_is_trusted_additively() {
        let _serial = ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();
        ensure_crypto_provider();
        let server = ok_server();

        let dir = std::env::temp_dir().join(format!(
            "chimera-transport-env-roots-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let bundle = dir.join("ca.pem");
        std::fs::write(&bundle, crate::testsupport::CA_PEM).expect("write CA bundle");
        let cert_dir = dir.join("certs");
        std::fs::create_dir_all(&cert_dir).expect("temp cert dir");
        std::fs::write(cert_dir.join("ca.pem"), crate::testsupport::CA_PEM)
            .expect("write CA into dir");

        let ca = crate::testsupport::ca_der();
        for env in [
            SSL_CERT_FILE_ENV,
            SSL_CERT_DIR_ENV,
            NODE_EXTRA_CA_CERTS_ENV,
            TRANSPORT_CA_FILE_ENV,
        ] {
            let previous = std::env::var(env).ok();
            let path = if env == SSL_CERT_DIR_ENV {
                cert_dir.clone()
            } else {
                bundle.clone()
            };
            std::env::set_var(env, &path);

            let roots = harvest_env_roots();
            assert!(!roots.is_empty(), "{env} must yield roots");
            assert!(
                roots.iter().any(|root| root.as_ref() == ca[0].as_ref()),
                "{env} must harvest the fixture CA"
            );

            let config = default_trust_config_with(&roots, false).expect("config builds");
            assert_eq!(
                config.alpn_protocols,
                vec![b"h2".to_vec(), b"http/1.1".to_vec()],
                "{env}: preconfigured config must keep ALPN"
            );
            let client = reqwest::Client::builder()
                .use_preconfigured_tls(config)
                .build()
                .expect("client builds");
            let response = client
                .get(server.https_url("/env-root"))
                .send()
                .await
                .unwrap_or_else(|error| panic!("{env} root must be trusted: {error}"));
            assert_eq!(response.status(), 200, "{env} root must be trusted");

            match previous {
                Some(value) => std::env::set_var(env, value),
                None => std::env::remove_var(env),
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
        restore_env(previous_env);
    }

    /// Default-deny is preserved: without the CA the same server is rejected.
    #[tokio::test]
    async fn profile_zero_still_rejects_an_untrusted_ca() {
        let _serial = ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous_env = clear_proxy_env();
        ensure_crypto_provider();
        let server = ok_server();

        let config = default_trust_config_with(&[], false).expect("config builds");
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(config)
            .build()
            .expect("client builds");
        let error = client
            .get(server.https_url("/untrusted"))
            .send()
            .await
            .expect_err("an unknown CA must not be trusted");
        let debug = format!("{error:?}");
        assert!(
            debug.contains("InvalidCertificate"),
            "unexpected rejection: {debug}"
        );
        restore_env(previous_env);
    }
}
