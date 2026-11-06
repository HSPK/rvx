import "./auth.css";
import {useEffect, useRef, useState} from "react";
import {Dialog as DialogPrimitive} from "radix-ui";
import {Eye, EyeOff} from "lucide-react";
import {Brand} from "../app/react-ui";
import {Button} from "@/components/ui/button";
import {SignInError, authenticationRestored, getSession, signIn, type SessionStatus} from "./session";

export function AuthenticationLoading({title, description, retry}: {title?: string; description?: string; retry?: () => void}) {
  return <section className="auth-card"><Brand />{title && <h1 className="auth-title">{title}</h1>}
    {description && <p className="auth-description">{description}</p>}
    {retry && <Button className="auth-submit" onClick={retry}>Retry</Button>}
  </section>;
}

export function SignInForm({onCompleted, recovery = false}: {onCompleted: (status: SessionStatus) => void; recovery?: boolean}) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [until, setUntil] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!until) return;
    const update = () => setRemaining(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [until]);
  async function submit() {
    if (busy || remaining) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(""); setInvalid(false);
    try {
      const status = await signIn(password, controller.signal);
      if (controller.signal.aborted) return;
      setPassword(""); onCompleted(status);
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(error instanceof SignInError ? error.message : "Unable to reach the server. Check your connection and try again.");
      if (error instanceof SignInError && error.retryAfter > 0) setUntil(Date.now() + error.retryAfter * 1000);
      else if (error instanceof SignInError && error.invalidPassword) {
        setInvalid(true);
      }
    } finally {if (!controller.signal.aborted) setBusy(false);}
  }
  return <section className="auth-card"><Brand /><h1 className="auth-title">{recovery ? "Session expired" : "Sign in"}</h1>
    {recovery && <p className="auth-description">Your unsaved changes are preserved.</p>}
    <form className="auth-form" method="post" action="/api/auth/login" aria-busy={busy}
      onSubmit={event => {event.preventDefault(); void submit();}}>
      <input type="hidden" name="username" value="rvx" autoComplete="username" />
      <label className="auth-label" htmlFor="rvx-sign-in-password">Password</label>
      <div className="auth-password">
        <input ref={input} className="auth-input" id="rvx-sign-in-password" name="password" type={visible ? "text" : "password"}
          value={password} autoComplete="current-password" required maxLength={256} autoCapitalize="off" spellCheck={false}
          aria-describedby="rvx-sign-in-error" aria-invalid={invalid || undefined} onChange={event => {
            setPassword(event.target.value); setInvalid(false); if (!remaining) setError("");
          }} />
        <Button className="auth-visibility" variant="ghost" size="icon" aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff /> : <Eye />}</Button>
      </div>
      <p className="auth-error" id="rvx-sign-in-error" role="alert" hidden={!error}>{error}</p>
      <Button type="submit" className="auth-submit" disabled={busy || remaining > 0}>
        {remaining ? `Try again in ${remaining}s` : busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  </section>;
}

export function AuthenticationRecovery({onRestored}: {onRestored: (status: SessionStatus) => void}) {
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    setChecking(true); setError(false);
    void getSession(request.signal).then(status => {
      if (request.signal.aborted) return;
      if (status.authenticated) {authenticationRestored(); onRestored(status);}
      else setChecking(false);
    }).catch(() => {if (!request.signal.aborted) {setChecking(false); setError(true);}});
    return () => request.abort();
  }, [attempt, onRestored]);
  return <DialogPrimitive.Root open>
    <DialogPrimitive.Portal><DialogPrimitive.Overlay className="auth-lock-overlay" />
      <DialogPrimitive.Content className="auth-lock" aria-label="Sign in again" aria-describedby={undefined}
        onEscapeKeyDown={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}>
        <DialogPrimitive.Title className="sr-only">Sign in again</DialogPrimitive.Title>
        {checking ? <AuthenticationLoading title="Checking session" description="Verifying your existing sign-in. Your changes are still here." />
          : error ? <AuthenticationLoading title="Unable to verify session"
            description="The authentication service could not be reached. Check your connection and retry. Your changes are still here."
            retry={() => setAttempt(value => value + 1)} />
            : <SignInForm recovery onCompleted={onRestored} />}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
