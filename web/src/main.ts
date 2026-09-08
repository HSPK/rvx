import "uplot/dist/uPlot.min.css";
import "./app/styles.css";
import "./app/chart-surface.css";
import {App} from "./app/app";
import {AuthenticationGate} from "./auth/gate";
import {authenticationRestored, getSession, loginPath, requireAuthentication, signOut, type SessionStatus} from "./auth/session";
import {brandMark} from "./app/brand";
import {button, el} from "./app/ui";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");

const lifetime = new AbortController();
let application: App | null = null;
let gate: AuthenticationGate | null = null;

/** Resolve session state before private bootstrap; expose a recoverable connection error without guessing. */
async function start(): Promise<void> {
  const loading = el("div", "auth-page"); loading.append(brandMark()); root!.replaceChildren(loading);
  let status: SessionStatus;
  try {
    status = await getSession(lifetime.signal);
  } catch (error) {
    if (lifetime.signal.aborted) return;
    const card = el("section", "auth-card");
    card.append(brandMark(), el("h1", "auth-title", "Unable to connect"),
      el("p", "auth-description", "RVX could not verify your session. Try again."),
      button("Retry", () => {void start();}, "auth-submit"));
    loading.replaceChildren(card); root!.replaceChildren(loading);
    return;
  }
  if (!status.authenticated) {location.replace(loginPath()); return;}
  authenticationRestored();
  gate?.destroy();
  gate = new AuthenticationGate(() => application?.suspendAuthentication(), status => {
    void application?.resumeAuthentication(status.authentication_required);
  });
  application = new App(root!, {required: status.authentication_required, signOut: async () => {
    await signOut(lifetime.signal);
    const destination = loginPath();
    application?.destroy(); application = null; gate?.destroy(); gate = null;
    root!.replaceChildren(); location.replace(destination);
  }});
  await application.start();
}
window.addEventListener("pagehide", event => {
  if (!event.persisted) {lifetime.abort(); gate?.destroy();}
});
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  if (!application) {void start(); return;}
  void getSession(lifetime.signal).then(status => {
    if (status.authenticated) gate?.restore(status); else requireAuthentication();
  }, () => {if (!lifetime.signal.aborted) requireAuthentication();});
});
await start();
