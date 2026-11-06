import "uplot/dist/uPlot.min.css";
import "./app/canvas.css";
import {useCallback, useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import {Tooltip} from "radix-ui";
import {Application} from "./app/application";
import {AuthenticationLoading, AuthenticationRecovery} from "./auth/components";
import {authenticationRequired, authenticationRestored, getSession, loginPath, requireAuthentication, signOut, type SessionStatus} from "./auth/session";

function Session() {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const restored = useCallback((status: SessionStatus) => {
    authenticationRestored(); setStatus(status); setSuspended(false);
  }, []);
  useEffect(() => {
    const request = new AbortController();
    setError(false);
    void getSession(request.signal).then(status => {
      if (request.signal.aborted) return;
      if (!status.authenticated) {location.replace(loginPath()); return;}
      authenticationRestored(); setStatus(status);
    }).catch(() => {if (!request.signal.aborted) setError(true);});
    return () => request.abort();
  }, [attempt]);
  useEffect(() => {
    const expired = () => setSuspended(true);
    const pageshow = (event: PageTransitionEvent) => {if (event.persisted) requireAuthentication();};
    window.addEventListener(authenticationRequired, expired);
    window.addEventListener("pageshow", pageshow);
    return () => {window.removeEventListener(authenticationRequired, expired); window.removeEventListener("pageshow", pageshow);};
  }, []);
  if (!status) return <div className="auth-page">{error
    ? <AuthenticationLoading title="Unable to connect" description="RVX could not verify your session. Try again." retry={() => setAttempt(value => value + 1)} />
    : <AuthenticationLoading />}</div>;
  return <>
    <Application suspended={suspended} authenticationRequired={status.authentication_required}
      onSignOut={async () => {
        await signOut(AbortSignal.timeout(15_000));
        location.replace(loginPath());
      }} />
    {suspended && <AuthenticationRecovery onRestored={restored} />}
  </>;
}

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");
createRoot(root).render(<Tooltip.Provider delayDuration={200}><Session /></Tooltip.Provider>);
