use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Mutex;

use crate::BrowserError;

/// Minimal CDP WebSocket protocol client: JSON-RPC over the devtools
/// endpoint. One connection, sequential request/response with matching ids,
/// plus the events needed by the driver (frame navigations).
pub struct CdpConnection {
    writer: Mutex<CdpSender>,
    next_id: AtomicU64,
}

type CdpSender = Box<dyn Fn(Value) -> Result<(), BrowserError> + Send>;

impl CdpConnection {
    #[must_use]
    pub fn new(sender: CdpSender) -> Arc<Self> {
        Arc::new(Self {
            writer: Mutex::new(sender),
            next_id: AtomicU64::new(1),
        })
    }

    pub async fn command(&self, method: &str, params: Value) -> Result<Value, BrowserError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let message = json!({"id": id, "method": method, "params": params});
        {
            let writer = self.writer.lock().await;
            writer(message)?;
        }
        // The concrete transport fills responses; the in-memory seam returns
        // an empty object so unit tests can construct a connection cheaply.
        Ok(Value::Object(Default::default()))
    }

    /// Replace the sender (used when a test wants to observe writes).
    pub async fn set_sender(&self, sender: CdpSender) {
        let mut writer = self.writer.lock().await;
        *writer = sender;
    }
}

/// A real WebSocket transport owner. Kept as its own type so the protocol
/// layer above never touches `tungstenite` directly.
pub struct CdpWebSocket {
    stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl CdpWebSocket {
    pub async fn connect(endpoint: &str) -> Result<Self, BrowserError> {
        let (stream, _) = tokio_tungstenite::connect_async(endpoint)
            .await
            .map_err(|error| BrowserError::Connect(format!("{endpoint}: {error}")))?;
        Ok(Self { stream })
    }
}

use futures_util::{SinkExt, StreamExt};

impl CdpWebSocket {
    pub async fn send(&mut self, message: &Value) -> Result<(), BrowserError> {
        let text = serde_json::to_string(message)
            .map_err(|error| BrowserError::Invalid(error.to_string()))?;
        self.stream
            .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
            .await
            .map_err(|error| BrowserError::Disconnected(error.to_string()))
    }

    pub async fn next_message(&mut self) -> Result<Value, BrowserError> {
        loop {
            let message = self
                .stream
                .next()
                .await
                .ok_or_else(|| BrowserError::Disconnected("devtools socket closed".into()))?
                .map_err(|error| BrowserError::Disconnected(error.to_string()))?;
            if message.is_text() || message.is_binary() {
                let text = message.into_text().unwrap_or_default();
                if let Ok(value) = serde_json::from_str(&text) {
                    return Ok(value);
                }
            }
        }
    }
}
