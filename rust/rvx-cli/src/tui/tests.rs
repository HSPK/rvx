use std::cell::Cell;
use std::rc::Rc;

use crossterm::event::KeyEvent;
use ratatui::backend::TestBackend;

use super::*;

struct RequestGuard(Rc<Cell<usize>>);

impl RequestGuard {
    fn enter(active: Rc<Cell<usize>>) -> Self {
        active.set(active.get() + 1);
        Self(active)
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

fn dashboard() -> DashboardConfig {
    toml::from_str(
        r#"
project = "p"
experiment = "e"
refresh_ms = 250
[[panels]]
type = "run-metadata"
"#,
    )
    .unwrap()
}

fn key(character: char) -> Event {
    Event::Key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE))
}

#[tokio::test]
async fn stalled_refresh_does_not_block_input_or_leave_a_request_after_quit() {
    let active = Rc::new(Cell::new(0));
    let starts = Cell::new(0);
    let mut input_count = 0;
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        interactive_loop(
            &mut terminal,
            &dashboard(),
            "http://fixture",
            || {
                starts.set(starts.get() + 1);
                let active = active.clone();
                async move {
                    let _guard = RequestGuard::enter(active);
                    std::future::pending::<Result<DashboardState>>().await
                }
            },
            || {
                if active.get() == 0 {
                    return Ok(None);
                }
                input_count += 1;
                Ok(Some(match input_count {
                    1..=3 => key('r'),
                    4 => Event::Resize(40, 10),
                    5 => key('j'),
                    _ => key('q'),
                }))
            },
        ),
    )
    .await
    .expect("keyboard must not wait for HTTP")
    .unwrap();
    assert_eq!(
        starts.get(),
        1,
        "manual refreshes must not overlap the pending request"
    );
    assert_eq!(active.get(), 0, "quitting must drop the in-flight request");
    let screen: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(screen.contains("Connecting to RVX."));
}

#[tokio::test]
async fn repeated_manual_refreshes_coalesce_into_one_followup() {
    let active = Rc::new(Cell::new(0));
    let starts = Cell::new(0);
    let mut presses = 0;
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        interactive_loop(
            &mut terminal,
            &dashboard(),
            "http://fixture",
            || {
                starts.set(starts.get() + 1);
                let active = active.clone();
                async move {
                    let _guard = RequestGuard::enter(active.clone());
                    assert_eq!(active.get(), 1);
                    tokio::time::sleep(Duration::from_millis(350)).await;
                    Ok(DashboardState::waiting("Last successful frame"))
                }
            },
            || {
                if starts.get() == 2 {
                    return Ok(Some(key('q')));
                }
                if active.get() > 0 && presses < 3 {
                    presses += 1;
                    return Ok(Some(key('r')));
                }
                Ok(None)
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(starts.get(), 2);
    assert_eq!(active.get(), 0);
    let screen: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(screen.contains("Last successful frame"));
}

#[tokio::test]
async fn input_errors_also_cancel_pending_refresh() {
    let active = Rc::new(Cell::new(0));
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        interactive_loop(
            &mut terminal,
            &dashboard(),
            "http://fixture",
            || {
                let active = active.clone();
                async move {
                    let _guard = RequestGuard::enter(active);
                    std::future::pending::<Result<DashboardState>>().await
                }
            },
            || {
                if active.get() > 0 {
                    Err(io::Error::other("input fixture failed"))
                } else {
                    Ok(None)
                }
            },
        ),
    )
    .await
    .unwrap();
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("input fixture failed"));
    assert_eq!(active.get(), 0);
}
