import {ExactJsonUnavailable, exactProperty, parseExactJson} from "../core/exact-json";
import type {ExperimentRun} from "../domain/types";
import type {RunMetadata} from "./runs";
import {humanize} from "./model";
import {button, dialog, el, message} from "./ui";

const previewCharacters = 64 * 1024;
interface ConfigurationPreview {text: string; notice: string | null}

/** Bound visible configuration text without cutting a UTF-16 surrogate pair or changing the stored download. */
function limitedConfiguration(text: string): ConfigurationPreview {
  if (text.length <= previewCharacters) return {text, notice: null};
  let end = previewCharacters;
  if (/[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  return {text: text.slice(0, end), notice: "Showing a limited preview. Download the configuration for the complete JSON."};
}

/** Pretty-print small exact JSON values and keep large, deep or invalid configuration explicitly readable. */
export function configurationPreview(text: string): ConfigurationPreview {
  const limited = limitedConfiguration(text);
  if (limited.notice) return limited;
  let wrapper: {configuration: unknown};
  try {
    JSON.parse(text);
    wrapper = parseExactJson(`{"configuration":${text}}`);
  }
  catch (error) {
    if (error instanceof SyntaxError) return {text, notice: "Invalid configuration JSON. Showing the stored text."};
    if (error instanceof ExactJsonUnavailable) return {text, notice: "This browser cannot format exact numeric values. Showing the stored JSON."};
    throw error;
  }
  const pending = [{value: wrapper.configuration, depth: 0}];
  let visited = 0;
  while (pending.length) {
    const {value, depth} = pending.pop()!;
    if (++visited > 4000 || depth > 24) return {text, notice: "Complex configuration is shown without formatting. The download remains complete."};
    if (value !== null && typeof value === "object") {
      const children: unknown[] = Object.values(value);
      if (visited + pending.length + children.length > 4000) return {text, notice: "Large configuration is shown without formatting. The download remains complete."};
      for (const child of children) pending.push({value: child, depth: depth + 1});
    }
  }
  return limitedConfiguration(exactProperty(wrapper, "configuration", 2));
}

/** Present one Run's registry identity and configuration without changing selected chart Runs or reading snapshots. */
export class RunDetails {
  private modal: ReturnType<typeof dialog>;
  private current: ExperimentRun | null = null;
  private context = "";

  /** Open one fixed right-side drawer owned by the application, not by an individual chart. */
  constructor(readonly runId: string, metadata: RunMetadata, private labelFor: (run: ExperimentRun) => string, onClose: () => void,
    private color: () => string, private chooseColor: () => void) {
    this.modal = dialog("Run details", "run-drawer", onClose);
    this.update(metadata);
  }

  /** Refresh changed registry fields while retaining scroll and stable DOM for unchanged metadata. */
  update(metadata: RunMetadata): void {
    const run = metadata.runs.find(run => run.id === this.runId);
    if (!run) {
      this.current = null;
      this.modal.body.replaceChildren(message("Run unavailable", "This Run is no longer present in the current registry."));
      return;
    }
    const experiment = metadata.experiments.find(experiment => experiment.id === run.experiment_id);
    const project = metadata.projects.find(project => project.id === experiment?.project_id);
    const label = this.labelFor(run);
    const context = `${project?.name ?? ""}\0${experiment?.name ?? ""}\0${label}`;
    if (this.current && context === this.context && (["name", "status", "config_json", "created_at_ns", "updated_at_ns"] as const).every(key => this.current![key] === run[key])) return;
    this.current = run; this.context = context;
    const scroll = this.modal.body.scrollTop;
    const summary = el("section", "run-detail-summary");
    summary.append(el("h3", "run-detail-name", label));
    const status = el("p", "run-detail-status");
    status.append(el("i", `run-status status-${run.status}`), el("span", "", humanize(run.status)));
    const color = button("Color", this.chooseColor, "button quiet run-color-detail");
    color.dataset.runColor = run.id; color.setAttribute("aria-label", `Change color for ${label}`);
    color.prepend(el("i", "run-color-dot")); status.append(color);
    summary.append(status);
    const fields = el("dl", "field-list run-detail-fields");
    for (const [label, value] of [
      ["Run ID", run.id], ["Project", project?.name ?? "Unavailable"],
      ["Experiment", experiment?.name ?? "Unavailable"],
      ["Created", new Date(run.created_at_ns / 1e6).toLocaleString()],
      ["Updated", new Date(run.updated_at_ns / 1e6).toLocaleString()],
    ]) {
      const row = el("div"); row.append(el("dt", "", label), el("dd", label === "Run ID" ? "run-detail-id" : "", value)); fields.append(row);
    }
    const configuration = el("section", "run-configuration"), heading = el("header", "run-config-heading");
    heading.append(el("h3", "", "Configuration"), button("Download JSON", () => this.download(), "text-button"));
    configuration.append(heading);
    const preview = configurationPreview(run.config_json);
    if (preview.notice) {
      const note = el("p", "run-config-notice muted", preview.notice); note.setAttribute("role", "status"); configuration.append(note);
    }
    const json = el("pre", "run-config-json", preview.text); json.tabIndex = 0; json.setAttribute("aria-label", "Run configuration JSON");
    configuration.append(json);
    this.modal.body.replaceChildren(summary, fields, configuration);
    this.refreshColor();
    this.modal.body.scrollTop = scroll;
  }

  /** Update the swatch in place while a nested color picker owns keyboard focus. */
  refreshColor(): void {this.modal.body.querySelector<HTMLElement>(".run-color-detail")?.style.setProperty("--run-color", this.color());}

  /** Download original configuration text, not a rounded object or the bounded preview. */
  private download(): void {
    if (!this.current) return;
    const url = URL.createObjectURL(new Blob([this.current.config_json], {type: "application/json"}));
    const link = el("a"); link.href = url; link.download = `rvx-run-${this.current.id}-config.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Close the owned drawer when another Run opens or the application leaves the workspace. */
  destroy(): void {this.modal.close(); this.current = null;}
}
