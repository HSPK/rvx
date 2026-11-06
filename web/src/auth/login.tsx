import "../app/canvas.css";
import "./auth.css";
import {useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import {AuthenticationLoading, SignInForm} from "./components";
import {getSession, returnPath} from "./session";

function Login() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const destination = returnPath(new URL(location.href).searchParams.get("next"));
  useEffect(() => {
    const appearance = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = appearance.matches ? "dark" : "light";
      document.documentElement.classList.toggle("dark", appearance.matches);
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", appearance.matches ? "#0e1014" : "#f3f4f6");
    };
    apply(); appearance.addEventListener("change", apply);
    return () => appearance.removeEventListener("change", apply);
  }, []);
  useEffect(() => {
    const request = new AbortController();
    setError(false); setReady(false);
    void getSession(request.signal).then(status => {
      if (request.signal.aborted) return;
      if (status.authenticated) location.replace(destination);
      else setReady(true);
    }).catch(() => {if (!request.signal.aborted) setError(true);});
    return () => request.abort();
  }, [attempt, destination]);
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {if (event.persisted) setAttempt(value => value + 1);};
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  return ready ? <SignInForm onCompleted={() => location.replace(destination)} />
    : <AuthenticationLoading {...(error ? {title: "Unable to connect", description: "The sign-in service is unavailable. Try again.",
      retry: () => setAttempt(value => value + 1)} : {})} />;
}

const root = document.getElementById("login");
if (!root) throw new Error("Missing login root.");
createRoot(root).render(<Login />);
