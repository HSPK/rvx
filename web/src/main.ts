import "./rvx/styles.css";
import {RvxAppShell} from "./rvx/shell-app";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");

const application = new RvxAppShell(root);
await application.start();
