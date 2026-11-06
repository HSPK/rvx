export function endpointTicks(ticks: number[], first: number, last: number, min: number, max: number, gap: number): number[] {
  const endpoints = [...new Set([first, last])].filter(value => Number.isFinite(value) && value >= min && value <= max);
  const spacing = Number.isFinite(gap) && gap > 0 ? gap : 0;
  return [...new Set([...ticks.filter(value => value >= min && value <= max &&
    endpoints.every(endpoint => Math.abs(value - endpoint) >= spacing)), ...endpoints])].sort((a, b) => a - b);
}
