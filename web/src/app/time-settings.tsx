import {useState} from "react";
import {Check} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogTitle} from "@/components/ui/dialog";
import {axisLabel, type RangeState} from "./model";
import {formatTimeBound, parseTimeBound} from "./time";
import {timeSettingsRange} from "./time-settings-model";

export interface TimeSettingsProps {
  range: RangeState;
  bounds?: {from?: number; to?: number};
  onChange: (range: RangeState) => void;
  onClose: () => void;
}

export function TimeSettings({range, bounds = range, onChange, onClose}: TimeSettingsProps) {
  const axis = range.axis;
  const [from, setFrom] = useState(() => formatTimeBound(bounds.from, axis));
  const [to, setTo] = useState(() => formatTimeBound(bounds.to, axis));
  const [error, setError] = useState(() => [bounds.from, bounds.to].some(value => !parseTimeBound(formatTimeBound(value, range.axis), range.axis).ok)
    ? "The current range contains an unsupported bound. Enter a new value or clear it." : "");
  const wall = axis === "wall_time", elapsed = axis === "elapsed";
  const label = (end: boolean) => `${end ? "To" : "From"} (${wall ? "local time" : elapsed ? "elapsed" : axisLabel(axis)})`;
  function apply() {
    const result = timeSettingsRange(range, bounds, axis, from, to, range.timeFormat ?? "auto");
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChange(result.range); onClose();
  }
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <DialogContent className="react-dialog dialog time-settings-dialog" aria-label="Time settings">
      <header className="dialog-header"><DialogTitle>Time settings</DialogTitle></header>
      <DialogDescription className="sr-only">Edit range bounds without changing charts until Apply.</DialogDescription>
      <form className="dialog-body" onSubmit={event => {event.preventDefault(); apply();}}>
        <p className="muted sr-only">{wall ? `Local time (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Leave either bound blank for no limit.`
          : elapsed ? "From each run's first observation. Use 30s, 5m or 1h 15m; blank means no limit."
          : `Use recorded ${axisLabel(axis)} coordinates. Blank means no limit.`}</p>
        <div className="time-bounds">
          <label className="field"><span>{label(false)}</span><input className="text-input" aria-label={label(false)}
            type={wall ? "datetime-local" : "text"} step="1" maxLength={128} inputMode={wall || elapsed ? "text" : "numeric"}
            placeholder={elapsed ? "e.g. 30m" : "No limit"} value={from} onChange={event => {setFrom(event.target.value); setError("");}} /></label>
          <label className="field"><span>{label(true)}</span><input className="text-input" aria-label={label(true)}
            type={wall ? "datetime-local" : "text"} step="1" maxLength={128} inputMode={wall || elapsed ? "text" : "numeric"}
            placeholder={elapsed ? "e.g. 2h" : "No limit"} value={to} onChange={event => {setTo(event.target.value); setError("");}} /></label>
        </div>
        <p role="alert" className="error-text">{error}</p>
        <div className="time-range-actions"><Button type="submit" className="button primary" aria-label="Apply time settings"><Check />Apply</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
