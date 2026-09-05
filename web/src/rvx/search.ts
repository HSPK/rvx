import type {
  ExperimentRecord,
  ExperimentRun,
  ExperimentSource,
  ProjectRecord,
} from "../domain/types";
import {parseRunParameters} from "./run-parameters";

interface SearchClause {
  field: string | null;
  value: string;
  exclude: boolean;
  operator: "contains" | "=" | ">" | "<" | ">=" | "<=";
}

export function matchesRunSearch(
  query: string,
  project: ProjectRecord,
  experiment: ExperimentRecord,
  run: ExperimentRun,
  sources: ExperimentSource[],
  parameters = parseRunParameters(run.config_json),
): boolean {
  const clauses = parseSearch(query);
  if (!clauses.length) return true;
  return clauses.every(clause => {
    const matched = clauseMatches(
      clause,
      project,
      experiment,
      run,
      sources,
      parameters,
    );
    return clause.exclude ? !matched : matched;
  });
}

function parseSearch(query: string): SearchClause[] {
  const tokens =
    query.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(token => token.trim()) ?? [];
  return tokens
    .map(token => {
      const exclude = token.startsWith("-");
      const normalized = exclude ? token.slice(1) : token;
      const expression = normalized.match(
        /^([^:><=]+)(:|>=|<=|=|>|<)(.+)$/,
      );
      const field = expression?.[1]?.toLowerCase() ?? null;
      const operator = expression?.[2] === ":"
        ? "contains"
        : expression?.[2] as SearchClause["operator"] | undefined
          ?? "contains";
      const rawValue = expression?.[3] ?? normalized;
      const value = rawValue.replace(/^"|"$/g, "").toLowerCase();
      return {field, value, exclude, operator};
    })
    .filter(clause => clause.value);
}

function clauseMatches(
  clause: SearchClause,
  project: ProjectRecord,
  experiment: ExperimentRecord,
  run: ExperimentRun,
  sources: ExperimentSource[],
  parameters: Record<string, string | number | boolean>,
): boolean {
  const values = fieldValues(
    clause.field,
    project,
    experiment,
    run,
    sources,
    parameters,
  );
  return values.some(value => compareValue(value, clause));
}

function fieldValues(
  field: string | null,
  project: ProjectRecord,
  experiment: ExperimentRecord,
  run: ExperimentRun,
  sources: ExperimentSource[],
  parameters: Record<string, string | number | boolean>,
): string[] {
  if (field === "project") return [project.name];
  if (field === "experiment" || field === "exp") return [experiment.name];
  if (field === "run") return [run.name];
  if (field === "status") return [run.status];
  if (field === "role") return sources.map(source => source.role);
  if (field === "node") {
    return sources.flatMap(source => [
      source.node_id ?? "",
      source.descriptor?.node_id ?? "",
    ]);
  }
  if (field === "source") {
    return sources.flatMap(source => [
      source.id,
      source.endpoint,
      source.source_session_id ?? "",
    ]);
  }
  if (field?.startsWith("param.")) {
    const parameter = field.slice("param.".length);
    const value = parameters[parameter];
    return value === undefined ? [] : [String(value)];
  }
  return [
    project.name,
    experiment.name,
    run.name,
    run.status,
    ...sources.flatMap(source => [
      source.role,
      source.node_id ?? "",
      source.descriptor?.node_id ?? "",
      source.endpoint,
      source.last_error ?? "",
    ]),
  ];
}

function compareValue(value: string, clause: SearchClause): boolean {
  if (clause.operator === "contains") {
    return value.toLowerCase().includes(clause.value);
  }
  if (clause.operator === "=") {
    return value.toLowerCase() === clause.value;
  }
  const left = Number(value);
  const right = Number(clause.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (clause.operator === ">") return left > right;
  if (clause.operator === "<") return left < right;
  if (clause.operator === ">=") return left >= right;
  return left <= right;
}
