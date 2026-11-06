import {useState, type CSSProperties} from "react";
import {Check, RotateCcw} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogTitle} from "@/components/ui/dialog";
import {palette} from "./model";

export interface RunColorPickerProps {
  color: string;
  onChange: (color: string | null) => boolean;
  onClose: () => void;
}

export function RunColorPicker({color, onChange, onClose}: RunColorPickerProps) {
  const [error, setError] = useState("");
  function choose(value: string | null) {
    if (onChange(value)) onClose();
    else setError("Applied for this page, but browser storage is unavailable.");
  }
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <DialogContent className="react-dialog dialog run-color-dialog" aria-label="Run color">
      <header className="dialog-header"><DialogTitle>Run color</DialogTitle></header>
      <DialogDescription className="sr-only">Choose a display color without changing recorded run configuration.</DialogDescription>
      <div className="dialog-body">
        <div className="run-color-palette">{palette.map(value => <Button key={value} type="button" className="run-color-swatch"
          style={{"--swatch-color": value} as CSSProperties} aria-label={`Use ${value}`} aria-pressed={color.toLowerCase() === value}
          onClick={() => choose(value)}>{color.toLowerCase() === value && <Check aria-hidden="true" />}<span className="sr-only">{value}</span></Button>)}</div>
        <div className="run-color-controls"><label className="field"><span>Custom</span><input type="color" aria-label="Custom run color"
          value={color} onChange={event => choose(event.target.value)} /></label>
          <Button type="button" variant="ghost" className="button quiet" onClick={() => choose(null)}><RotateCcw />Automatic</Button>
        </div>
        {error && <p role="alert" className="error-text">{error}</p>}
      </div>
    </DialogContent>
  </Dialog>;
}
