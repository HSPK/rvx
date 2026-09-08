import {afterEach, expect, it, vi} from "vitest";
import {ApiClient} from "./api-client";
import {exactProperty} from "./exact-json";

afterEach(() => vi.unstubAllGlobals());

it("uses only the table contract endpoints and preserves exact cells, IDs and summary numeric text", async () => {
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => new Response(url.endsWith("summary")
    ? '{"axis":"elapsed","rows":[{"run_id":"r","source_id":"s","path":"/count","observations":2,"count":1,"missing":1,"current":null,"minimum":9007199254740993,"average":9007199254740993,"p95":9007199254740993,"maximum":9007199254740993,"snapshot_id":"18446744073709551615","observed_at_ns":1788595200000000123}]}'
    : url.endsWith("catalog") ? '{"tables":[],"truncated":false}'
    : '{"columns":[{"path":"$value","name":"Value"}],"rows":[{"run_id":"r","source_id":"s","snapshot_id":"18446744073709551615","row_key":"0","cells":{"$value":{"kind":"number","text":"18446744073709551615","truncated":false}}}],"snapshots":[],"total":1,"offset":0,"limit":75}',
  {headers: {"Content-Type": "application/json"}}));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient();
  const summary = await api.tableSummary({run_ids: ["r"], paths: ["/count"], axis: "elapsed"});
  expect(exactProperty(summary.rows[0]!, "minimum")).toBe("9007199254740993");
  await api.tableCatalog({run_ids: ["r"], source_ids: ["s"]});
  const rows = await api.tableRows({run_ids: ["r"], path: "/values", snapshot_ids: ["18446744073709551615"], columns: ["$value"], sort: {path: "$value", direction: "desc"}, offset: 0, limit: 75});
  expect(rows.rows[0]?.cells.$value?.text).toBe("18446744073709551615");
  expect(rows.rows[0]?.snapshot_id).toBe("18446744073709551615");
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(["/api/tables/summary", "/api/tables/catalog", "/api/tables/rows"]);
  for (const call of fetcher.mock.calls) expect(call[1]).toMatchObject({method: "POST", credentials: "same-origin"});
});
