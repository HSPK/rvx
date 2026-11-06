import {useEffect, useRef, useState} from "react";
import {ConnectionMonitor} from "./connection";
import {Tooltip} from "./react-ui";
import {Button} from "@/components/ui/button";

export function ConnectionIndicator({suspended, onReconnect}: {suspended: boolean; onReconnect: () => void}) {
  const [status, setStatus] = useState({state: "connecting", text: "Connecting", label: "", announcement: "Connecting"});
  const reconnected = useRef(onReconnect);
  reconnected.current = onReconnect;
  useEffect(() => {
    const monitor = new ConnectionMonitor(() => reconnected.current(), ({announce, ...next}) => {
      setStatus(old => ({...next, announcement: announce ? next.text : old.announcement}));
    });
    if (suspended) monitor.suspend(); else monitor.start();
    return () => monitor.destroy();
  }, [suspended]);
  return <Tooltip label={status.text}>
    <Button variant="ghost" size="icon-sm" className="connection-status" data-state={status.state} aria-label={status.text}>
      <span className="connection-label" aria-hidden="true" hidden={!status.label}>{status.label}</span>
      <i className="connection-dot" /><span className="sr-only" role="status" aria-live="polite">{status.announcement}</span>
    </Button>
  </Tooltip>;
}
