import type {ChartCatalog, ChartMetric} from "../domain/snapshots";
import {metricName, type ChartSpec} from "./model";

interface MetricEntry {
  metric: ChartMetric;
  name: string;
  group: string;
  added: boolean;
  context: string;
  search: string;
}
const groups = ["Training", "Throughput", "Pipeline", "Resources", "Other", "Diagnostics", "Already added"];

/** Rank useful available fields before diagnostics, while retaining every field for search. */
export function metricEntries(catalog: ChartCatalog, charts: ChartSpec[]): MetricEntry[] {
  const chosen = new Set(charts.map(chart => chart.path));
  const defaults = new Set(catalog.defaults);
  const names = new Map<string, number>();
  for (const metric of catalog.metrics) names.set(metricName(metric), (names.get(metricName(metric)) ?? 0) + 1);
  return catalog.metrics.map(metric => {
    const name = metricName(metric);
    const added = chosen.has(metric.path);
    const diagnostic = /^\/collectors(?:\/|$)|^\/(?:metrics\/)?monitor(?:~1|\/)/.test(metric.path);
    const group = added ? "Already added" : diagnostic ? "Diagnostics" : groups.includes(metric.group) ? metric.group : "Other";
    return {
      metric, name, group, added,
      context: (names.get(name) ?? 0) > 1 || diagnostic ? metric.path : "",
      search: `${name} ${metric.name} ${metric.group} ${metric.unit ?? ""} ${metric.path} ${metric.sources.map(source => source.role).join(" ")}`.toLowerCase(),
    };
  }).sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group)
    || Number(defaults.has(b.metric.path)) - Number(defaults.has(a.metric.path))
    || a.name.localeCompare(b.name) || a.metric.path.localeCompare(b.metric.path));
}

/** Prefer direct name matches over incidental path matches when searching across groups. */
export function matchingMetrics(entries: MetricEntry[], query: string): MetricEntry[] {
  const text = query.toLowerCase().trim();
  const terms = text.split(/\s+/).filter(Boolean);
  if (!terms.length) return entries;
  return entries.filter(entry => terms.every(term => entry.search.includes(term)))
    .map(entry => {
      const name = entry.name.toLowerCase();
      const rank = (entry.added ? 8 : 0) + (entry.group === "Diagnostics" ? 4 : 0)
        + (terms.every(term => name.includes(term)) ? 0 : 2) + (name.startsWith(text) ? 0 : 1);
      return {entry, rank};
    })
    .sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name))
    .map(({entry}) => entry);
}
