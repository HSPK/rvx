use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{timeout, Instant};

use crate::auth::CookieSession;
use crate::AppState;

const MAX_CONNECTIONS: usize = 128;
const MAX_MESSAGE_BYTES: usize = 1024;
const MAX_MESSAGES_PER_SECOND: u32 = 10;
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const SEND_TIMEOUT: Duration = Duration::from_secs(1);
const CLOSE_TIMEOUT: Duration = Duration::from_millis(250);

struct Connections {
    shutdown: watch::Sender<bool>,
    permits: Arc<Semaphore>,
    tasks: Mutex<JoinSet<()>>,
}

/// Owns bounded heartbeat tasks independently of metric ingestion and HTTP keepalive connections.
#[derive(Clone)]
pub struct UiConnections(Arc<Connections>);

impl Default for UiConnections {
    /// Allocate an independent socket owner with the standard resource bounds.
    fn default() -> Self {
        Self::new()
    }
}

impl UiConnections {
    /// Create one connection owner per router/server; dropping its last handle aborts remaining tasks.
    pub fn new() -> Self {
        let (shutdown, _) = watch::channel(false);
        Self(Arc::new(Connections {
            shutdown,
            permits: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            tasks: Mutex::new(JoinSet::new()),
        }))
    }

    /// Reject new sockets, send going-away close frames, then drain or abort every owned task.
    /// The bounded deadline also covers peers that never read a close frame.
    pub async fn shutdown(&self) {
        let mut tasks = {
            let mut guard = self.0.tasks.lock().unwrap();
            self.0.shutdown.send_replace(true);
            self.0.permits.close();
            std::mem::replace(&mut *guard, JoinSet::new())
        };
        if timeout(Duration::from_secs(2), async {
            while tasks.join_next().await.is_some() {}
        })
        .await
        .is_err()
        {
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
        }
    }

    /// Reap finished sockets and register an upgrade only while the owner is accepting work.
    fn attach(
        &self,
        socket: WebSocket,
        permit: OwnedSemaphorePermit,
        session: Option<CookieSession>,
    ) {
        let mut tasks = self.0.tasks.lock().unwrap();
        if *self.0.shutdown.borrow() {
            return;
        }
        while tasks.try_join_next().is_some() {}
        tasks.spawn(heartbeat(
            socket,
            self.0.shutdown.subscribe(),
            permit,
            session,
        ));
    }
}

/// Reserve capacity before upgrading an already authenticated same-origin request.
pub(crate) async fn upgrade(
    State(state): State<AppState>,
    session: Option<Extension<CookieSession>>,
    ws: WebSocketUpgrade,
) -> Response {
    let connections = state.connections;
    let Ok(permit) = connections.0.permits.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "WebSocket connection limit reached or server shutting down"})),
        )
            .into_response();
    };
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .write_buffer_size(0)
        .max_write_buffer_size(4096)
        .on_upgrade(move |socket| async move {
            connections.attach(socket, permit, session.map(|Extension(session)| session));
        })
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Heartbeat {
    #[serde(rename = "ping")]
    Ping { id: String },
}

/// Attempt a protocol close without allowing an unresponsive peer to delay shutdown.
async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = timeout(
        CLOSE_TIMEOUT,
        socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: Cow::Borrowed(reason),
        }))),
    )
    .await;
}

/// Echo bounded ping IDs while enforcing rate, idle, write, and shutdown deadlines.
async fn heartbeat(
    mut socket: WebSocket,
    mut shutdown: watch::Receiver<bool>,
    _permit: OwnedSemaphorePermit,
    session: Option<CookieSession>,
) {
    let mut window = Instant::now();
    let mut count = 0;
    loop {
        if *shutdown.borrow() {
            close(&mut socket, 1001, "server shutting down").await;
            return;
        }
        let message = tokio::select! {
            biased;
            _ = shutdown.changed() => {
                close(&mut socket, 1001, "server shutting down").await;
                return;
            }
            message = timeout(IDLE_TIMEOUT, socket.recv()) => message,
        };
        let message = match message {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(_))) => {
                close(&mut socket, 1009, "invalid or oversized frame").await;
                return;
            }
            Ok(None) => return,
            Err(_) => {
                close(&mut socket, 1008, "heartbeat idle timeout").await;
                return;
            }
        };
        if window.elapsed() >= Duration::from_secs(1) {
            window = Instant::now();
            count = 0;
        }
        count += 1;
        if count > MAX_MESSAGES_PER_SECOND {
            close(&mut socket, 1008, "heartbeat rate limit").await;
            return;
        }
        let response = match message {
            Message::Text(text) => match serde_json::from_str::<Heartbeat>(&text) {
                Ok(Heartbeat::Ping { id }) if !id.is_empty() && id.len() <= 64 && id.is_ascii() => {
                    Message::Text(json!({"type": "pong", "id": id}).to_string())
                }
                _ => {
                    close(&mut socket, 1008, "expected ping with a bounded ASCII id").await;
                    return;
                }
            },
            Message::Ping(bytes) => Message::Pong(bytes),
            Message::Pong(_) => continue,
            Message::Close(_) => {
                close(&mut socket, 1000, "closed").await;
                return;
            }
            Message::Binary(_) => {
                close(&mut socket, 1008, "text JSON required").await;
                return;
            }
        };
        if let Some(session) = &session {
            let active = tokio::select! {
                biased;
                _ = shutdown.changed() => {
                    close(&mut socket, 1001, "server shutting down").await;
                    return;
                }
                result = timeout(SEND_TIMEOUT, session.active()) => matches!(result, Ok(Ok(true))),
            };
            if !active {
                close(&mut socket, 1008, "session expired or revoked").await;
                return;
            }
        }
        tokio::select! {
            biased;
            _ = shutdown.changed() => {
                close(&mut socket, 1001, "server shutting down").await;
                return;
            }
            result = timeout(SEND_TIMEOUT, socket.send(response)) => {
                if !matches!(result, Ok(Ok(()))) { return; }
            }
        }
    }
}
