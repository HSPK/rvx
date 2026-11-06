import {useEffect, useMemo, useRef, useState, type CSSProperties} from "react";
import {Download, Palette} from "lucide-react";
import {Tabs} from "radix-ui";
import {Button} from "@/components/ui/button";
import {Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle} from "@/components/ui/sheet";
import type {ExperimentRun} from "../domain/types";
import {humanize} from "./model";
import {configurationPreview} from "./run-configuration";
import type {RunMetadata} from "./run-selector";

export interface RunInspectorProps {
  runId: string;
  metadata: RunMetadata;
  labelFor: (run: ExperimentRun) => string;
  colorFor: (id: string) => string;
  onColor: (id: string) => void;
  onClose: () => void;
}

export function RunInspector({runId, metadata, labelFor, colorFor, onColor, onClose}: RunInspectorProps) {
  const run = metadata.runs.find(run => run.id === runId);
  const experiment = metadata.experiments.find(experiment => experiment.id === run?.experiment_id);
  const project = metadata.projects.find(project => project.id === experiment?.project_id);
  const preview = useMemo(() => run ? configurationPreview(run.config_json) : null, [run?.config_json]);
  const label = run ? labelFor(run) : "Run unavailable";
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const downloadRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!downloadUrl) return;
    downloadRef.current?.click();
    const timer = setTimeout(() => {URL.revokeObjectURL(downloadUrl); setDownloadUrl(null);}, 1000);
    return () => {clearTimeout(timer); URL.revokeObjectURL(downloadUrl);};
  }, [downloadUrl]);
  function download() {
    if (!run) return;
    setDownloadUrl(URL.createObjectURL(new Blob([run.config_json], {type: "application/json"})));
  }
  const fields = run ? [
    ["Run ID", run.id], ["Project", project?.name ?? "Unavailable"], ["Experiment", experiment?.name ?? "Unavailable"],
    ["Created", new Date(run.created_at_ns / 1e6).toLocaleString()], ["Updated", new Date(run.updated_at_ns / 1e6).toLocaleString()],
  ] : [];
  return <Sheet open onOpenChange={open => {if (!open) onClose();}}>
    <SheetContent className="dialog run-drawer overflow-y-auto" aria-label="Run details" style={{width: "min(560px, 100vw)", maxWidth: "100vw"}}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (opener?.isConnected) opener.focus({preventScroll: true});
      }}>
      <SheetHeader className="dialog-header"><SheetTitle className="sr-only">Run details</SheetTitle>
        <h2 className="run-detail-name">{label}</h2>
        <SheetDescription className="sr-only">Read-only registry metadata and original run configuration.</SheetDescription>
      </SheetHeader>
      <div className="dialog-body">
        {!run ? <section className="empty-message"><h3>Run unavailable</h3><p>This Run is no longer present in the current registry.</p></section> : <>
          <section className="run-detail-summary"><div className="run-detail-status">
            <i className={`run-status status-${run.status}`} /><span>{humanize(run.status)}</span>
            <Button type="button" variant="ghost" className="button quiet run-color-detail" data-run-color={run.id}
              style={{"--run-color": colorFor(run.id)} as CSSProperties} aria-label={`Change color for ${label}`} onClick={() => onColor(run.id)}>
              <i className="run-color-dot" /><Palette />Color</Button>
          </div></section>
          <dl className="field-list run-detail-fields">{fields.map(([name, value]) => <div key={name}>
            <dt>{name}</dt><dd className={name === "Run ID" ? "run-detail-id" : undefined}>{value}</dd>
          </div>)}</dl>
          <Tabs.Root defaultValue="config" key={run.id}>
            <Tabs.List className="snapshot-view-tabs" aria-label="Run detail panels">
              <Tabs.Trigger className="snapshot-view-tab" value="config">Config &amp; summary</Tabs.Trigger>
              <Tabs.Trigger className="snapshot-view-tab" value="metadata">Metadata</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="config"><section className="run-configuration">
              <header className="run-config-heading"><h3>Configuration</h3><Button type="button" variant="ghost" className="text-button" onClick={download}><Download />Download JSON</Button></header>
              <a ref={downloadRef} hidden href={downloadUrl ?? undefined} download={`rvx-run-${run.id}-config.json`}>Download original configuration</a>
              {preview?.notice && <p role="status" className="run-config-notice muted">{preview.notice}</p>}
              <pre tabIndex={0} className="run-config-json" aria-label="Run configuration JSON">{preview?.text}</pre>
            </section></Tabs.Content>
            <Tabs.Content value="metadata"><section className="run-configuration">
              <h3>Registry metadata</h3><dl className="field-list">
                {[["Run ID", run.id], ["Experiment ID", run.experiment_id], ["Project ID", project?.id ?? "Unavailable"], ["Name", run.name],
                  ["Status", run.status], ["Created (ns)", String(run.created_at_ns)], ["Updated (ns)", String(run.updated_at_ns)]].map(([name, value]) =>
                  <div key={name}><dt>{name}</dt><dd className="run-detail-id">{value}</dd></div>)}
              </dl>
            </section></Tabs.Content>
          </Tabs.Root>
        </>}
      </div>
    </SheetContent>
  </Sheet>;
}
