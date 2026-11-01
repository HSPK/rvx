import "./auth.css";
import {button, el} from "../app/ui";
import {brandMark} from "../app/brand";
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
    document.body.append(modal); modal.showModal();
    void this.verify(modal);
  }
  private async verify(modal: HTMLDialogElement): Promise<void> {
    const card = el("section", "auth-card"), heading = el("h1", "auth-title", "Checking session");
    const description = el("p", "auth-description", "Verifying your existing sign-in. Your changes are still here.");
    card.append(brandMark(), heading, description); modal.replaceChildren(card);
    let status: SessionStatus;
    try {status = await getSession(this.lifetime.signal);}
    catch {
      if (this.modal !== modal || this.lifetime.signal.aborted) return;
      heading.textContent = "Unable to verify session";
      description.textContent = "The authentication service could not be reached. Check your connection and retry. Your changes are still here.";
      const retry = button("Retry", () => {void this.verify(modal);}, "auth-submit");
      card.append(retry); retry.focus();
      return;
    }
    if (this.modal !== modal || this.lifetime.signal.aborted) return;
    if (status.authenticated) {this.restore(status); return;}
    this.form = new SignInForm(status => this.restore(status), true);
    modal.replaceChildren(this.form.element); this.form.focus();
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
