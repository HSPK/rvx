import {brandMark} from "../app/brand";
import {button, el, icon} from "../app/ui";
import {SignInError, signIn, type SessionStatus} from "./session";

/** Own one accessible password form and its request/timer lifecycle, for login and in-place recovery. */
export class SignInForm {
  readonly element = el("section", "auth-card");
  private form = el("form", "auth-form");
  private password = el("input", "auth-input");
  private submit = button("Sign in", () => {}, "auth-submit");
  private error = el("p", "auth-error");
  private lifetime = new AbortController();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  /** Present the same minimal credential entry without introducing an account system. */
  constructor(private completed: (status: SessionStatus) => void, recovery = false) {
    this.form.method = "post"; this.form.action = "/api/auth/login";
    const brand = brandMark(), heading = el("h1", "auth-title", recovery ? "Session expired" : "Sign in");
    const hint = el("p", "auth-description", recovery ? "Sign in again to continue. Your changes are still here." : "Use your server access password.");
    const label = el("label", "auth-label", "Password"), field = el("div", "auth-password");
    this.password.type = "password"; this.password.name = "password"; this.password.id = "rvx-sign-in-password";
    this.password.autocomplete = "current-password"; this.password.required = true; this.password.maxLength = 256;
    this.password.setAttribute("autocapitalize", "off"); this.password.spellcheck = false;
    this.password.setAttribute("aria-describedby", "rvx-sign-in-error");
    label.htmlFor = this.password.id;
    const username = el("input"); username.type = "hidden"; username.name = "username"; username.value = "rvx"; username.autocomplete = "username";
    const visibility = button("", () => {
      const visible = this.password.type === "password";
      this.password.type = visible ? "text" : "password";
      visibility.setAttribute("aria-label", visible ? "Hide password" : "Show password");
      visibility.setAttribute("aria-pressed", String(visible));
      visibility.replaceChildren(icon(visible ? "eyeOff" : "eye"));
    }, "auth-visibility");
    visibility.setAttribute("aria-label", "Show password"); visibility.setAttribute("aria-pressed", "false");
    visibility.append(icon("eye"));
    this.error.id = "rvx-sign-in-error"; this.error.setAttribute("role", "alert");
    this.error.hidden = true;
    this.submit.type = "submit";
    field.append(this.password, visibility);
    this.form.append(username, label, field, this.error, this.submit);
    this.form.addEventListener("submit", event => {event.preventDefault(); void this.authenticate();});
    this.password.addEventListener("input", () => {
      this.password.removeAttribute("aria-invalid");
      if (!this.retryTimer) this.error.hidden = true;
    });
    this.element.append(brand, heading, hint, this.form);
  }

  /** Focus credentials only after the form is attached or its modal is shown. */
  focus(): void {this.password.focus();}
  /** Surface a failed background session check without replacing an active credential submission. */
  sessionCheckFailed(): void {
    if (this.busy) return;
    this.error.textContent = "Unable to verify your session. Try signing in again.";
    this.error.hidden = false;
  }

  /** Send at most one password request and retain an actionable failure instead of a browser challenge. */
  private async authenticate(): Promise<void> {
    if (this.busy || this.retryTimer || !this.form.reportValidity()) return;
    this.busy = true; this.submit.disabled = true; this.error.hidden = true;
    this.password.removeAttribute("aria-invalid");
    this.form.setAttribute("aria-busy", "true"); this.submit.querySelector("span")!.textContent = "Signing in…";
    try {
      const status = await signIn(this.password.value, this.lifetime.signal);
      this.password.value = "";
      this.completed(status);
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      this.error.textContent = error instanceof SignInError ? error.message
        : "Unable to reach the server. Check your connection and try again.";
      this.error.hidden = false;
      if (error instanceof SignInError && error.retryAfter > 0) this.cooldown(error.retryAfter);
      else if (error instanceof SignInError && error.invalidPassword) {
        this.password.setAttribute("aria-invalid", "true"); this.password.focus(); this.password.select();
      }
    } finally {
      this.busy = false; this.form.setAttribute("aria-busy", "false");
      if (!this.retryTimer) {this.submit.disabled = false; this.submit.querySelector("span")!.textContent = "Sign in";}
    }
  }

  /** Respect a bounded server retry interval without repeatedly sending rejected credentials. */
  private cooldown(seconds: number): void {
    const until = Date.now() + seconds * 1000;
    const update = (): void => {
      const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      this.submit.querySelector("span")!.textContent = remaining ? `Try again in ${remaining}s` : "Sign in";
      this.submit.disabled = remaining > 0;
      if (!remaining && this.retryTimer) {clearInterval(this.retryTimer); this.retryTimer = null;}
    };
    this.retryTimer = setInterval(update, 1000); update();
  }

  /** Clear credentials and release pending work when the page or authentication lock closes. */
  destroy(): void {
    this.lifetime.abort(); this.password.value = "";
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.element.remove();
  }
}
