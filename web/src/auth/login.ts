import "./auth.css";
import {brandMark} from "../app/brand";
import {button, el} from "../app/ui";
import {SignInForm} from "./form";
import {getSession, returnPath, type SessionStatus} from "./session";

const root = document.getElementById("login");
if (!root) throw new Error("Missing login root.");
let lifetime = new AbortController();
let form: SignInForm | null = null;
const destination = returnPath(new URL(location.href).searchParams.get("next"));

/** Avoid showing credentials to already authenticated or explicitly local-only browsers. */
async function start(): Promise<void> {
  root!.replaceChildren(brandMark());
  const signal = lifetime.signal;
  let status: SessionStatus;
  try {
    status = await getSession(signal);
  } catch (error) {
    if (signal.aborted) return;
    const card = el("section", "auth-card");
    card.append(brandMark(), el("h1", "auth-title", "Unable to connect"),
      el("p", "auth-description", "The sign-in service is unavailable. Try again."),
      button("Retry", () => {void start();}, "auth-submit"));
    root!.replaceChildren(card);
    return;
  }
  if (signal.aborted) return;
  if (status.authenticated) {location.replace(destination); return;}
  form = new SignInForm(() => location.replace(destination));
  root!.replaceChildren(form.element); form.focus();
}
window.addEventListener("pagehide", () => {lifetime.abort(); form?.destroy(); form = null;});
window.addEventListener("pageshow", event => {if (event.persisted) {lifetime = new AbortController(); void start();}});
await start();
