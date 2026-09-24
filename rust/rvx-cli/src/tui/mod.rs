mod client;
mod render;

use std::io::{self, IsTerminal, Stdout};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Modifier, Style};
use ratatui::widgets::Paragraph;
use ratatui::Terminal;

use rvx_config::DashboardConfig;

use client::{base_url, DashboardClient, DashboardState};
use render::{fit, render};

pub async fn run(
    config_path: PathBuf,
    cli_url: Option<String>,
    run_id: Option<String>,
    once: bool,
) -> Result<()> {
    let configuration = rvx_config::load(&config_path)?;
    let dashboard = configuration
        .dashboard
        .as_ref()
        .context("config does not contain a [dashboard] section")?;
    let base_url = base_url(&configuration, cli_url)?;
    let client = DashboardClient::new(&base_url, dashboard, run_id)?;
    if once {
        let state = client.refresh().await?;
        let width = crossterm::terminal::size()
            .map(|(width, _)| usize::from(width))
            .unwrap_or(120)
            .max(40);
        println!(
            "{}",
            render(dashboard, &state, &base_url, width, None).join("\n")
        );
        return Ok(());
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        bail!("rvx tui requires an interactive terminal; use --once for plain output");
    }
    interactive(client, dashboard, &base_url).await
}

async fn interactive(
    client: DashboardClient<'_>,
    dashboard: &DashboardConfig,
    base_url: &str,
) -> Result<()> {
    let mut terminal = open_terminal()?;
    let result = interactive_loop(&mut terminal, client, dashboard, base_url).await;
    let cleanup = close_terminal(&mut terminal);
    result.and(cleanup)
}

async fn interactive_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    client: DashboardClient<'_>,
    dashboard: &DashboardConfig,
    base_url: &str,
) -> Result<()> {
    let mut state = DashboardState::waiting("Connecting to RVX.");
    let mut error = None;
    let mut next_refresh = Instant::now();
    let mut scroll: usize = 0;
    loop {
        if Instant::now() >= next_refresh {
            match client.refresh().await {
                Ok(updated) => {
                    state = updated;
                    error = None;
                }
                Err(failure) => error = Some(format!("{failure:#}")),
            }
            next_refresh = Instant::now() + Duration::from_millis(dashboard.refresh_ms);
        }
        let size = terminal.size()?;
        let viewport = usize::from(size.height.saturating_sub(1)).max(1);
        let lines = render(
            dashboard,
            &state,
            base_url,
            usize::from(size.width).max(20),
            error.as_deref(),
        );
        let maximum = lines.len().saturating_sub(viewport);
        scroll = scroll.min(maximum);
        terminal.draw(|frame| {
            let areas =
                Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).split(frame.area());
            let text = lines.join("\n");
            frame.render_widget(
                Paragraph::new(text).scroll((scroll.min(u16::MAX as usize) as u16, 0)),
                areas[0],
            );
            let last = (scroll + viewport).min(lines.len());
            let footer = format!(
                "[q] quit  [r] refresh  [j/k] scroll  {}-{}/{}",
                if lines.is_empty() { 0 } else { scroll + 1 },
                last,
                lines.len()
            );
            frame.render_widget(
                Paragraph::new(fit(&footer, usize::from(areas[1].width)))
                    .style(Style::default().add_modifier(Modifier::REVERSED)),
                areas[1],
            );
        })?;
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(()),
            KeyCode::Char('r') => next_refresh = Instant::now(),
            KeyCode::Char('j') | KeyCode::Down => scroll = (scroll + 1).min(maximum),
            KeyCode::Char('k') | KeyCode::Up => scroll = scroll.saturating_sub(1),
            KeyCode::PageDown | KeyCode::Char(' ') => scroll = (scroll + viewport).min(maximum),
            KeyCode::PageUp => scroll = scroll.saturating_sub(viewport),
            KeyCode::Char('g') => scroll = 0,
            KeyCode::Char('G') => scroll = maximum,
            _ => {}
        }
    }
}

fn open_terminal() -> Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    if let Err(error) = execute!(stdout, EnterAlternateScreen) {
        let _ = disable_raw_mode();
        return Err(error.into());
    }
    match Terminal::new(CrosstermBackend::new(stdout)) {
        Ok(mut terminal) => {
            if let Err(error) = terminal.hide_cursor() {
                let _ = disable_raw_mode();
                let _ = execute!(terminal.backend_mut(), LeaveAlternateScreen);
                return Err(error.into());
            }
            Ok(terminal)
        }
        Err(error) => {
            let _ = disable_raw_mode();
            let _ = execute!(io::stdout(), LeaveAlternateScreen);
            Err(error.into())
        }
    }
}

fn close_terminal(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}
