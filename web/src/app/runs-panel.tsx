import type {ReactNode} from "react";
import {ChevronDown, ChevronLeft, ChevronRight, ChevronUp, LogOut, Moon, RefreshCw, Sun} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Brand} from "./react-ui";

export interface RunsPanelProps {
  selector: ReactNode;
  connection: ReactNode;
  collapsed: boolean;
  expanded: boolean;
  storageError: boolean;
  theme: "light" | "dark";
  live: boolean;
  refreshing: boolean;
  authenticationRequired: boolean;
  signingOut: boolean;
  authenticationSuspended: boolean;
  onTheme: () => void;
  onLive: (live: boolean) => void;
  onRefresh: () => void;
  onLogout: () => void;
  onCollapsed: (collapsed: boolean) => void;
  onExpanded: (expanded: boolean) => void;
}

export function RunsPanel(props: RunsPanelProps) {
  const {collapsed, expanded} = props;
  return <div className="runs-panel" data-collapsed={collapsed} data-controls-open={expanded}>
    <header className="runs-panel-header">
      <div className="runs-panel-brand"><Brand /></div>
      <Button variant="ghost" size="icon" className="runs-panel-toggle"
        aria-label={collapsed ? "Expand Runs panel" : "Collapse Runs panel"} aria-expanded={!collapsed}
        aria-controls="rvx-run-selector" onClick={() => props.onCollapsed(!collapsed)}>
        {collapsed ? <ChevronRight /> : <ChevronLeft />}
      </Button>
      <Button variant="ghost" size="icon" className="runs-panel-mobile-toggle"
        aria-label="Manage runs" aria-expanded={expanded} aria-controls="rvx-run-selector"
        onClick={() => props.onExpanded(!expanded)}>
        {expanded ? <ChevronUp /> : <ChevronDown />}
      </Button>
    </header>
    <div className="runs-panel-content">{props.selector}</div>
    {props.storageError && <p role="status" className="panel-storage-error">Unable to save panel state in this browser.</p>}
    <footer className="runs-panel-footer">
      <Button variant={props.live ? "secondary" : "ghost"} size="sm" aria-label="Live"
        aria-pressed={props.live} className="runs-live" onClick={() => props.onLive(!props.live)}>Live</Button>
      <div className="connection-host">{props.connection}</div>
      <Button variant="ghost" size="icon" aria-label="Refresh runs" title="Refresh runs" disabled={props.refreshing} onClick={props.onRefresh}>
        <RefreshCw />
      </Button>
      <Button variant="ghost" size="icon" aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} appearance`}
        title="Toggle theme" onClick={props.onTheme}>{props.theme === "dark" ? <Sun /> : <Moon />}</Button>
      {props.authenticationRequired && <Button variant="ghost" size="icon" aria-label="Sign out" title="Sign out"
        disabled={props.signingOut || props.authenticationSuspended} onClick={props.onLogout}><LogOut /></Button>}
    </footer>
  </div>;
}
