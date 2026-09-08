import "./auth.css";
import {el} from "../app/ui";
import {SignInForm} from "./form";
import {authenticationRequired, authenticationRestored, getSession, type SessionStatus} from "./session";

/** Lock the current document on expiry while retaining its live workspace and unsaved draft. */
export class AuthenticationGate {
  private lifetime = new AbortController();
  private modal: HTMLDialogElement | null = null;
  private form: SignInForm | null = null;
  private previous: HTMLElement | null = null;
  constructor(private suspend: () => void, private resume: (status: SessionStatus) => void) {
    window.addEventListener(authenticationRequired, () => this.open(), {signal: this.lifetime.signal});
  }
  /** Allow one recovery form to own authentication even when several requests fail together. */
  private open(): void {
    if (this.modal) return;
    this.suspend();
    this.previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = el("dialog", "auth-lock"); this.modal = modal;
    modal.setAttribute("aria-label", "Sign in again");
    modal.addEventListener("cancel", event => event.preventDefault());
    this.form = new SignInForm(status => this.restore(status), true);
    modal.append(this.form.element); document.body.append(modal); modal.showModal(); this.form.focus();
    // Another tab may already have renewed the browser's cookie while this request was in flight.
    void getSession(this.lifetime.signal).then(status => {
      if (this.modal === modal && status.authenticated) this.restore(status);
    }, () => {if (this.modal === modal && !this.lifetime.signal.aborted) this.form?.sessionCheckFailed();});
  }
  /** Resume only verified sessions, including documents restored from browser history. */
  restore(status: SessionStatus): void {
    authenticationRestored();
    this.modal?.close(); this.form?.destroy(); this.form = null; this.modal?.remove(); this.modal = null;
    this.resume(status);
    if (this.previous?.isConnected) this.previous.focus({preventScroll: true});
    this.previous = null;
  }
  /** Release credentials and event ownership when the application signs out or leaves the page. */
  destroy(): void {
    this.lifetime.abort(); this.form?.destroy(); this.form = null;
    this.modal?.remove(); this.modal = null;
  }
}
