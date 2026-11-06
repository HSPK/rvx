import {useMemo, type CSSProperties, type KeyboardEvent} from "react";
import type {SnapshotAggregateResponse, SnapshotAggregateSeries, SnapshotAggregateValue, SnapshotBarView} from "../../domain/snapshot-views";
import type {TableSource} from "../../domain/tables";
import {barGeometry, barMeasures, cellText, finiteNumber, segmentKey, tracePaint} from "./react-model";
import {provenance, SnapshotTooltip, type Readout, type VisualNames} from "./react-details";

export function SnapshotBars({data, view, names}: {data: SnapshotAggregateResponse; view: SnapshotBarView; names: VisualNames}) {
  const measures = barMeasures(view), geometry = useMemo(() => barGeometry(data.groups, view), [data, view]);
  const owners = useMemo(() => {
    const unique = new Map<string, {key: string; run: string; source: string; snapshot: TableSource | undefined; tone: number}>();
    for (const group of data.groups) for (const series of group.series) {
      const key = JSON.stringify([series.run_id, series.source_id]);
      unique.set(key, {key, run: series.run_id, source: series.source_id, snapshot: data.snapshots.find(snapshot => snapshot.snapshot_id === series.snapshot_id), tone: 0});
    }
    const perRun = new Map<string, number>();
    return [...unique.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(owner => {
      owner.tone = perRun.get(owner.run) ?? 0; perRun.set(owner.run, owner.tone + 1); return owner;
    });
  }, [data]);
  type Owner = typeof owners[number];
  const swatchStyle = (owner: Owner, index: number): CSSProperties => {
    const trace = owner.tone * measures.length + index, pattern = Math.floor(trace / 8);
    return {"--sv-color": tracePaint(names.colorFor(owner.run), trace),
      ...(pattern ? {backgroundImage: `repeating-linear-gradient(${pattern * 22.5}deg, transparent 0 2px, #ffffffa0 2px 3px)`} : {})} as CSSProperties;
  };
  function readout(owner: Owner, name: string, aggregate: SnapshotAggregateValue | undefined, series: SnapshotAggregateSeries | undefined): Readout {
    return [[name, aggregate ? cellText(aggregate.value) + (view.unit ? ` ${view.unit}` : "") : series ? "missing" : "not recorded"],
      ...provenance(owner.run, owner.source, owner.snapshot, names), ["Aggregation", view.aggregation],
      ...(aggregate ? [["Accounting", `${aggregate.count} counted · ${aggregate.missing} missing · ${aggregate.non_numeric} nonnumeric${aggregate.approximate ? " · approximate" : ""}`] as [string, string]] : []),
      ...(aggregate?.value.kind === "number" && finiteNumber(aggregate.value) === null ? [["Geometry", "Outside finite numeric range; exact value retained"] as [string, string]] : [])];
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key) || !(event.target instanceof HTMLButtonElement)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-sv-mark]")], index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1)))]?.focus();
  }
  const vertical = view.orientation === "vertical", zero = -geometry.minimum / (geometry.maximum - geometry.minimum);
  return <div className={`sv-bars ${owners.length === 1 ? "sv-single-owner" : ""}`} data-orientation={view.orientation} data-layout={view.layout} onKeyDown={navigate}>
    <div className="sv-bar-legend" aria-label="Run, Source and value fields">{owners.flatMap(owner => measures.map((measure, index) =>
      <span className="sv-trace-legend" key={`${owner.key}-${measure.id}`} title={`Source ${owner.source}${measure.path !== undefined ? ` · ${measure.path || "(root)"}` : ""}`}>
        <i className={`sv-trace-swatch ${Math.floor((owner.tone * measures.length + index) / 8) ? "sv-pattern" : ""}`} style={swatchStyle(owner, index)} />
        <span>{owners.length === 1 ? measure.path !== undefined ? names.fieldName(measure.path) : "Count"
          : `${names.runName(owner.run)} · ${owner.snapshot?.label ?? owner.source} · ${measure.path !== undefined ? names.fieldName(measure.path) : "Count"}`}</span>
      </span>))}</div>
    <div className="sv-bar-viewport" role="region" aria-label="Current snapshot bars" tabIndex={0}><div className="sv-bar-chart">
      {data.groups.map(group => {
        const categoryText = group.cells.map(cell => cellText(cell)).join(" · ");
        return <section className="sv-bar-category" key={group.key}><h3 className="sv-category-label" title={categoryText}>{categoryText}</h3>
          <div className="sv-bar-lanes">{owners.flatMap(owner => {
            const series = group.series.find(series => series.run_id === owner.run && series.source_id === owner.source);
            return (view.layout === "stacked" ? [measures] : measures.map(measure => [measure])).map((rowMeasures, laneIndex) =>
              <div className="sv-bar-lane" key={`${owner.key}-${laneIndex}`}>
                <span className="sv-bar-source" title={`Source ${owner.source}`}>{names.runName(owner.run)} · {owner.snapshot?.label ?? owner.source}</span>
                <svg className="sv-bar-track" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-label={`${categoryText} ${names.runName(owner.run)}`}>
                  <line className="sv-bar-zero" x1={vertical ? 0 : zero * 1000} x2={vertical ? 1000 : zero * 1000} y1={vertical ? (1 - zero) * 200 : 0} y2={vertical ? (1 - zero) * 200 : 200} />
                  {rowMeasures.map(measure => {
                    const index = measures.findIndex(item => item.id === measure.id), aggregate = series?.measures[measure.id];
                    const segment = series ? geometry.segments.get(segmentKey(group.key, series, measure.id)) : undefined;
                    if (!segment || segment.value === null) return null;
                    const start = (Math.min(segment.start, segment.end) - geometry.minimum) / (geometry.maximum - geometry.minimum), length = Math.abs(segment.end - segment.start) / (geometry.maximum - geometry.minimum);
                    const trace = owner.tone * measures.length + index, pattern = Math.floor(trace / 8), name = measure.path !== undefined ? names.fieldName(measure.path) : "Count";
                    return <SnapshotTooltip key={measure.id} title={categoryText} rows={readout(owner, name, aggregate, series)} clickReadout>
                      <rect data-sv-mark={JSON.stringify([group.key, owner.key, measure.id])} data-run={owner.run} data-source={owner.source} data-field={measure.id}
                        data-value={aggregate!.value.text} data-start={segment.start} data-end={segment.end}
                        x={vertical ? 100 : Math.min(999, start * 1000)} y={vertical ? Math.min(199, Math.max(0, 1 - start - length) * 200) : 35}
                        width={vertical ? 800 : Math.max(1, length * 1000)} height={vertical ? Math.max(1, length * 200) : 130}
                        fill={tracePaint(names.colorFor(owner.run), trace)} stroke={pattern ? names.colorFor(owner.run) : undefined}
                        strokeDasharray={pattern ? `${pattern + 1} 2` : undefined} strokeWidth={pattern ? 2 : undefined} />
                    </SnapshotTooltip>;
                  })}
                </svg>
                <div className="sv-bar-values">{rowMeasures.map(measure => {
                  const index = measures.findIndex(item => item.id === measure.id), aggregate = series?.measures[measure.id], name = measure.path !== undefined ? names.fieldName(measure.path) : "Count";
                  const value = aggregate ? cellText(aggregate.value, view.decimals) : series ? "missing" : "not recorded", unit = view.unit ? ` ${view.unit}` : "";
                  return <SnapshotTooltip key={measure.id} title={categoryText} rows={readout(owner, name, aggregate, series)} clickReadout>
                    <button type="button" className="sv-bar-value" data-sv-mark={JSON.stringify([group.key, owner.key, measure.id])} data-kind={aggregate?.value.kind ?? (series ? "missing" : "not-recorded")}
                      aria-label={`${categoryText} · ${names.runName(owner.run)} · Source ${owner.snapshot?.label ?? owner.source} · ${name}: ${value}${unit}`}>
                      <i className="sv-trace-swatch" style={swatchStyle(owner, index)} /><span>{measures.length > 1 && <span className="sv-bar-value-label">{name}: </span>}{value}{unit}</span>
                    </button>
                  </SnapshotTooltip>;
                })}</div>
              </div>);
          })}</div>
        </section>;
      })}
      {!data.groups.length && <p className="sv-empty muted">No categories match this snapshot query.</p>}
    </div></div>
  </div>;
}
