//! Shared test-only fixtures: a local plaintext HTTP/1.1 server and a local
//! TLS server serving a CA-signed certificate, both counting requests.
//!
//! The certificate fixtures are static PEMs (a 10-year leaf signed by a test
//! CA) on purpose: Apple's platform verifier rejects that leaf on validity
//! period, which is exactly the real-world case the additive extra-roots
//! verifier has to handle.
#![cfg(test)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

pub const CA_PEM: &str = "\
-----BEGIN CERTIFICATE-----
MIIDBDCCAeygAwIBAgIUStsoQNJ3kpcbQ/2YQjfm7UvDe9MwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPY2hpbWVyYS10ZXN0LWNhMB4XDTI2MTEyMDEwMzExMVoX
DTM2MTExNzEwMzExMVowGjEYMBYGA1UEAwwPY2hpbWVyYS10ZXN0LWNhMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7DywV1VJ9ODT/0zyTyw90ghpZv+1
i0FL7FrHxLyqXKmdzhj2QYZQyxTISuF683NoEZoZ3n4kMjt8+PSG2p/txy8M2n0d
/RAZccKfBzSyKg69zXj/CpIzwQI0R1puFqYcmx8o/ke6UeAThh3hB1KPcrhvNn9t
dhBEgF/VPSgLky6JDKgFQbsJOhjaXUQkEzUIIgc101mdBB1ZR9+tGFeqY30CY7QN
7Lnfco7FmIip+Y1OC2ciitjEDxNUPjWIhwLlWsveX0sU+YIN+ZB/ie5m1Jsz8FGd
iEjtU26FvGv5oFjg12IN31sit8k/sRTvvEZS3aZ99BsIc6Wiw4X/ph9DFQIDAQAB
o0IwQDAdBgNVHQ4EFgQUjIZyh8khpGrrDUFtqg+TuaWrgc0wDwYDVR0TAQH/BAUw
AwEB/zAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBAEz8PykfKbCi
CL3an7Nc4zu91LFW8W4QjcE579/cXbIrIbKQJBO0UKUNCEh22RLmym/XbnTGG2m4
HOHxtygyV/I87I6Ef3UjavNaCshiNXKf8KRhRGbR6b7G4OkxZ6+pGwinH7JacriC
GLpj7k0+9XdFFZCw/KPnX5GnUqUr/zyPQnEf0c6c1K8uLqBznOiyh03S6A9TdHNL
qX0qGr0ICxtweGsMj33RjI/w7cLu9D8uHFXYx8Plbddm99sDB7/Eu5GOVOrqApFW
ASlWOYv+xZBwQq0bqXFFGIwJP8uCcUlBTFGTbktN7S/qdmBkR2t4MPjlIlfo5QyQ
ACam2pV/UfI=
-----END CERTIFICATE-----
";

pub const SERVER_PEM: &str = "\
-----BEGIN CERTIFICATE-----
MIIDCjCCAfKgAwIBAgIURmjNxUdQ3NFEvNAuY5DQjyUGtXswDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPY2hpbWVyYS10ZXN0LWNhMB4XDTI2MTEyMDEwMzExMVoX
DTM2MTExNzEwMzExMVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAhtnus0rA99TQ+jXWIoIqKqWAPrcutyRpJTrQ
DMmPqoTVHm9S8SvHrchqNd8vez+se/V48gGpUdhcepGlw01bYkp6p477zHI2qZP6
M2o3gOAipvZgdTEek+pvTvmhP9RA5jpSSOHlw+1Gcg1OgrYwt4Eo2VShUBRsvhIl
4iEAyf73kS6b0Ag5T7JKyCPaJdI1zb2A22KGoy63aNR181ZIk7x0LTAwQBcwPxmy
jZq7K1oxjdLET3t9yDdLUk2s9WV8HFpK8NOgDSvfqZZFv/rhbRcyenwx3RuX3oz0
YVt5aBZmD9js8uqHfb2kBjbiXtH7hriZNxmhYX8vAQLBnt6NkQIDAQABo04wTDAa
BgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCQYDVR0TBAIwADAOBgNVHQ8BAf8E
BAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQELBQADggEBAIik
r8ciroa3oM1VUNvrrRySvHQb4Sniy8IIP+h7yYzJjdnAxjgKbn1zNurTO/i8CKSG
u6sDf67EKwXp3YHhdoRsR0tIqMKSE8+KxTH7nCUk8O/Dg9XpQAp7IGVBriMQNATr
qkUCtK68E5B54kinettqxYvJyQoRvhV221Z/TyubCZlfIMRS8ChZuI4XT4Ql7X7/
8KG+jujqonTsl3otz8M7CnOsVClIBBb4hj965W6cvymdrqRERFX2kttVt3saHFkv
onwN43wq+b1jnkVQq5hRTU9kUBPZJhrQYsY3l9uzc680Mu1S7WwA7LPPxIcW6mvo
vehFv5Ydcv7EA4oRNh0=
-----END CERTIFICATE-----
";

pub const SERVER_KEY: &str = "\
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCG2e6zSsD31ND6
NdYigioqpYA+ty63JGklOtAMyY+qhNUeb1LxK8etyGo13y97P6x79XjyAalR2Fx6
kaXDTVtiSnqnjvvMcjapk/ozajeA4CKm9mB1MR6T6m9O+aE/1EDmOlJI4eXD7UZy
DU6CtjC3gSjZVKFQFGy+EiXiIQDJ/veRLpvQCDlPskrII9ol0jXNvYDbYoajLrdo
1HXzVkiTvHQtMDBAFzA/GbKNmrsrWjGN0sRPe33IN0tSTaz1ZXwcWkrw06ANK9+p
lkW/+uFtFzJ6fDHdG5fejPRhW3loFmYP2Ozy6od9vaQGNuJe0fuGuJk3GaFhfy8B
AsGe3o2RAgMBAAECggEAAbSzNQumAEP34xkrySyo5L1x6nHMs9TGlR17xM99AjAD
SgEUbxltkFVplLJXRDtxZN27CoT88BKwZ9/BkI5BEy+7xz52wpWEXZSSDqY3NhEa
22vqh5wQpxMOAt8q2F+rL+NQIsaUxybo+mpLXrACA/0sobBozYeRianXB9eyCSEE
5s66nPDQGy6D/vu/ihb8yxyGA9eoUARyFHWU+LthlEcsjFIpC1bsG32AEvyRRQc0
bEbQkBm5NsiCuF1DGNvu1tDaTF2m2I9tf8HcIrXElpWKjBV2JRQ8+8fbCvao/NBf
3bRRoJIxLVeXB0Eq3iMlKKaubbzzpURQxAMfYQVd7wKBgQC8WT9yO3Rjy5g1vxf0
80tFG5AeMd86kdi2DQRs+LCwOtHL5XTqb0B4ahayBYplIIwxnHUE3boJpqieOG1A
X2TAbNQnYrb+k5/3T7Ov7JjKSppcoFWU4g5rxZLsftVNkvN10uCttR4nNQJVdhab
ociF4ePOyhLz4FouE7dC+0vhTwKBgQC3SZQCpN8LwhJtH9Vf67XmlQ2Tk2SVe3sB
qUHny0HXrv3C1nu0CuDLQOm4ffv+2bDkujiWiCxjbjX0+zFpI9LpUmNLGJizFOot
dplHxl9Zi/usJoPAByFkAbl2+ZjYLozqxjrU66Tzyu95JyjfctcC6Fn8YUUBpFva
AEvcX0orHwKBgDx/Bgvw4M91A2yv9kftJU4LLl0kc6jiU5MV10gREN9p5RzylH0A
QtrqaGPBt9QHgkAlGsj3Vtvmtd4sDZtRiJDt467K3DAkxoqvBO4KtoCzOaVqslJh
0XP4P9rKWkTSYHSFyTjCJe897YP5rAVND5VBGuS+rxu6Af0uw/w1rwetAoGASDVB
jWUcxkoX7kvbSSXYjNXt+lTYDJgQFtByuXn3H5y+NnM/WufqNckGCvv/OiDTMtk2
j/9n1WhG85O+nJhTcD5YBe7TwcGcnHqb2o4JZILkjKbDwvRMMFUJlxiwIYL9W0Tr
SpTncHBjtcw6qwVYNboKMYa0o/f3g8QYHuKfmqsCgYAGwv69fl9R0Qvt1wHfj1Dv
4SZENvNUQO1F3N/cGF69pMFQ9/XwF00M8rCNnGOEpE7mKB1xbg3UdKqoHcscFBAn
U+TW26cmmaVbEhpjM+MMU9Ie6og8EFg5QoLKgyKXodZrNmZWQ1FOmTa/dz2PL8GC
QfBFMaV7wlx14mQKIoWV7g==
-----END PRIVATE KEY-----
";

/// A running local server plus the number of fully received requests.
pub struct TestServer {
    pub port: u16,
    pub requests: Arc<AtomicUsize>,
}

impl TestServer {
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    pub fn https_url(&self, path: &str) -> String {
        format!("https://127.0.0.1:{}{path}", self.port)
    }

    pub fn request_count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn read_request(stream: &mut impl Read) -> Option<(String, String, String)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(position) = find_head_end(&buf) {
            break position;
        }
        match stream.read(&mut chunk) {
            Ok(0) => return None,
            Ok(read) => buf.extend_from_slice(&chunk[..read]),
            Err(_) => return None,
        }
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);

    while buf.len() < head_end + 4 + content_length {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => buf.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }

    let body = String::from_utf8_lossy(&buf[head_end + 4..]).into_owned();
    let method = head
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string();
    Some((method, body, head))
}

fn serve<F, S>(stream: &mut S, handler: &F, requests: &AtomicUsize)
where
    F: Fn(&str, &str, &str) -> String,
    S: Read + Write,
{
    let Some((method, body, head)) = read_request(stream) else {
        return;
    };
    requests.fetch_add(1, Ordering::SeqCst);
    let _ = stream.write_all(handler(&method, &body, &head).as_bytes());
    let _ = stream.flush();
}

/// Plaintext HTTP/1.1 server. The handler receives `(method, body, head)` and
/// returns the complete raw response.
pub fn spawn_http_server<F>(handler: F) -> TestServer
where
    F: Fn(&str, &str, &str) -> String + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    let port = listener.local_addr().expect("local addr").port();
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&requests);
    let handler = Arc::new(handler);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let handler = Arc::clone(&handler);
            let counter = Arc::clone(&counter);
            std::thread::spawn(move || serve(&mut stream, handler.as_ref(), &counter));
        }
    });

    TestServer { port, requests }
}

fn tls_config() -> Arc<rustls::ServerConfig> {
    let certs = CertificateDer::pem_slice_iter(SERVER_PEM.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .expect("fixture certificate parses");
    let key =
        PrivateKeyDer::from_pem_slice(SERVER_KEY.as_bytes().into()).expect("fixture key parses");
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("safe default TLS versions")
    .with_no_client_auth()
    .with_single_cert(certs, key)
    .expect("fixture cert and key match");
    Arc::new(config)
}

/// TLS server serving [`SERVER_PEM`]. Same handler contract as
/// [`spawn_http_server`].
pub fn spawn_tls_server<F>(handler: F) -> TestServer
where
    F: Fn(&str, &str, &str) -> String + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    let port = listener.local_addr().expect("local addr").port();
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&requests);
    let handler = Arc::new(handler);
    let config = tls_config();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(tcp) = stream else { continue };
            let handler = Arc::clone(&handler);
            let counter = Arc::clone(&counter);
            let config = Arc::clone(&config);
            std::thread::spawn(move || {
                let Ok(connection) = rustls::ServerConnection::new(config) else {
                    return;
                };
                let Ok(write_half) = tcp.try_clone() else {
                    return;
                };
                let mut tls = rustls::StreamOwned::new(connection, write_half);
                serve(&mut tls, handler.as_ref(), &counter);
            });
        }
    });

    TestServer { port, requests }
}

/// DER of the fixture CA, for callers that need to seed a trust store.
pub fn ca_der() -> Vec<CertificateDer<'static>> {
    CertificateDer::pem_slice_iter(CA_PEM.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .expect("fixture CA parses")
}
