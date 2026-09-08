# RVX: UX-First, Charts-First Design

**Project stage: Pre-alpha / very early development.**

**Implementation status: Server-owned workspaces, always-on refresh, and connection-aware chrome implemented and deployed.**
This document supersedes both the workstation design and the intermediate
Run-page/Compare-page flow. There is one maintained interface.
Current structured snapshots remain intact; retired scalar archives are
offline data, not a compatibility read path.

## 1. Product decision

RVX should help a user answer three questions quickly:

1. Is this run progressing normally?
2. Which experiment is better, and where do their behaviors differ?
3. Which configuration and execution produced these results?

**Charts are the primary experience. Snapshots are the underlying evidence.**

**Multi-run comparison is native, not a separate action or destination.**
Runs are the selection dimension of a chart workspace. Selecting a Run changes
its plotted traces; it does not open a different page.

The backend remains snapshot-first: complete structured observations are the
source of truth, and numeric series are derived from their fields. This does
not require the user to start by browsing snapshots, Sources, or JSON trees.
There is still no independent metric logging channel.

## 2. Why the previous experience was too complicated

The previous interface exposed its implementation model before delivering value:

```text
Run -> View -> Board -> Section -> Panel -> Source -> JSON pointer -> Chart
```

It also presented several overlapping navigation and control systems: context
navigation, analytical tabs, boards, panel editors, global live controls,
view-level live controls, and raw-state inspection.

It was configurable, but configuration had become a prerequisite for analysis.
The result was a monitoring framework the user had to operate, rather than a
product that immediately explained their experiment.

The replacement flow is:

```text
Runs selection <-> Shared charts
      |
Run details and configuration
```

Information density means useful evidence per screen and per interaction.
It does not mean smaller fonts, more controls, or exposing every internal object.

## 3. UX principles

| Principle | Consequence |
| --- | --- |
| Useful before configurable | An initial Run selection produces meaningful charts |
| Native comparison | Runs and Charts coexist; selecting Runs immediately changes traces |
| Familiar interactions | Toggle a Run, add a metric, zoom a chart |
| Progressive disclosure | Run identity and configuration live in a contextual drawer |
| One control per concern | One time range and one shared always-on refresh cadence |
| Stable reading surface | Header, Run rail, and chart controls stay fixed while chart content scrolls |
| Preserve analytical context | Refresh, selection, and Run details do not reset zoom or chart arrangement |
| Honest evidence | Missing data, stale Sources, approximations, and errors remain distinguishable |
| Simplicity before generality | Do not build a generic dashboard/workbench framework |

The advanced area must not become a hiding place for the entire old UI.
Features that do not support a concrete user task should be deleted.

## 4. Information architecture

### Sign-in boundary

Use a dedicated, lightweight RVX sign-in page rather than a browser Basic-auth
prompt. Show the brand, one password field, a reveal control, and a clear Sign
in action. Password-manager autocomplete, Enter submission, pending state,
inline errors, retry limits, and mobile/light/dark layouts are first-class.
Do not invent user accounts, signup, or password-reset actions for the shared
server-password model. Keep public login assets separate from private app assets.

An expired session locks the existing workspace in place while preserving
drafts, chart canvases, and selections. Signing back in resumes those owners
instead of navigating away. Sign-out uses the existing save/discard safeguard
and clears the protected view only after the server confirms revocation.

The primary UI is one analysis workspace:

| Surface | Primary task | Visible by default |
| --- | --- | --- |
| Runs selector | Choose the executions plotted now | Project/experiment filters, search, selection and status |
| Shared charts | Understand differences and progress | Relevant curves, consistent Run colors, time range |
| Run details drawer | Read execution identity and configuration | Run status, project, experiment, timestamps, complete configuration |

Project and Experiment remain organizational entities, but the user should not
have to navigate separate summary pages for each level before reaching a run.
A project selector and experiment filter provide scope directly in the Run
selector. On desktop it sits beside the charts; on mobile it opens in a
compact sheet without replacing the chart workspace.
The sheet fits short lists and bounds long ones with virtual scrolling.
Its search position stays fixed as results change; wide, short screens use
compact two-column filters rather than pushing all Runs below the controls.
The page itself does not scroll. The chart area and the virtual Run list own
their respective scroll regions; their headers and controls stay in place.
On wide screens the Run rail starts at the viewport's left edge; a centered,
max-width application wrapper must not create an external left gutter.
Scrollbars remain discoverable but restrained, and chart menus must not be
clipped by the chart scroll container.

Sources, Attempts, Sessions, snapshot IDs, storage statistics, and protocol
details are not primary navigation destinations. They remain available through
the APIs and CLI rather than a point-level Inspect interface.

### Runs selector

- Use compact, consistently aligned Run rows. Status is a colored dot, with its
  meaning available through accessible text and a tooltip, not a repeated
  Running/Finished label on every row.
- Keep real keyboard-operable checkboxes with clear checked/disabled states,
  quiet styling, and comfortable hit targets.
- Keep project/experiment/status/search filters together.
- Group project and experiment selectors side by side; keep status and refresh
  beside search. Do not allocate separate rows to selection counts or lone
  toolbar actions. Selected Runs, range, freshness, and Add share one desktop
  toolbar; narrow screens wrap related groups rather than individual controls.
- Resize the desktop Run rail by dragging its right edge or using the focused
  separator's arrow keys. Persist the chosen width on the server for that
  browser; small viewports may clamp the effective width without overwriting
  the wider-screen preference. The mobile selector remains a sheet.
- Do not repeat a Runs heading and total above an already identifiable selector.
  Place refresh beside discovery controls, with an accessible name and explicit
  pending state that does not shift the filters or list.
- A checkbox or its row label immediately adds/removes that Run's traces.
- There is no Compare button, Apply-selection action, or Run-to-Charts jump.
- Filtering the list does not silently unselect Runs. Active selections remain
  visible even when outside the current filter.
- An explicit empty selection shows a selection state, never stale curves or
  invalid empty-scope requests. Selecting again restores the chart arrangement.
- A registry with no Runs explains CLI setup and offers metadata refresh,
  rather than asking the user to choose a nonexistent execution.
- Keep full IDs, large configuration objects, and infrastructure metadata out
  of the default rows.
- Open Run details through the row's information action or a selected Run's
  name. These actions never toggle the selection or replace the chart workspace.
  Checkbox/row-label selection retains its existing immediate-overlay behavior.
  Reveal the information action on row hover or keyboard focus, retaining its
  space to avoid shifting names. Touch devices keep the action visible.

### Shared workspace

```text
RVX mark   Current workspace v   Save or Saved       Connection  Theme
--------------------------------------------------------------------
Run filters         Selected Runs      Time range   Updated      Add
[x] Run A           ------------------------------------------------
[x] Run B           Loss                       Reward
[ ] Run C           [A + B curves]             [A + B curves]
                    Resources                                  v
                    Throughput                 GPU utilization
                    [A + B curves]             [A + B curves]
```

This is a structural sketch, not a mandatory chart list. Only recorded,
meaningful fields appear. Most of the first viewport should be chart content,
not headers, counters, instructions, or configuration controls.
Do not display an extra **Charts / Since first observation** title row.
Alignment belongs in the time controls. Observation freshness includes seconds
and remains near the time range. There is no Live/Pause control. Keep the RVX
mark and wordmark optically centered; the browser favicon uses the same mark.

The compact header owns workspace identity rather than a generic
"Experiment analysis" label. It shows the current saved name or default draft,
a workspace picker and one persistence slot: **Save** when edited/unnamed,
**Saving...** during submission, and **Saved** after successful persistence.
Never display Saved and a separate Save button simultaneously. All states
share one baseline and height immediately beside the workspace name. Saved
fades out after three seconds and does not reappear on live refresh. A name
is requested only for an unnamed workspace.
Save is a filled action, with an amber dot and background for unsaved edits;
it must not look like passive text. Successful saving also waits for the active
workspace selection to settle server-side before completing the transition.
The current set is marked in the picker. Save failures retain the working
draft and do not publish false saved metadata.
The picker, save-name form, and save/discard confirmations are anchored below
the header group rather than centered over the page. Show the cached list
immediately, keep the current workspace first, and search long lists in place.
Rename through the current row's pencil or F2 on the workspace name; Enter
commits and Escape cancels. Renaming retains the same ID and saved panel
definition, without implicitly saving unsaved panel edits. Save as is a
separate action.

Workspace definitions are shared server-side. Theme, desktop rail width, Run
color overrides, and the selected workspace are server-stored but scoped to an opaque browser
cookie, so another browser can open the same definitions without changing its
appearance or rail width. No local-storage copy is authoritative. Existing
browser-only definitions remain untouched and are not imported automatically.
Do not display migration explanations or routine persistence implementation notes.
The server renders the saved browser theme into the initial HTML, with a tiny
critical background style before external assets load. Session/preference
loading surfaces and client hydration retain that theme, including when the
operating-system appearance differs. Do not briefly initialize dark workspaces
as light, or add a second local-storage preference to hide startup flicker.
Server saves use revision checks; conflicts preserve the draft and require an
explicit resolution rather than silently overwriting another browser's edit.

Immediately to the left of Theme, a small connection indicator reflects a real
authenticated WebSocket heartbeat. Green means a matching pong was received;
connecting/reconnecting/offline states are distinct. Hover or keyboard focus
shows the measured WebSocket round-trip latency. Do not label an HTTP timing
or local wall-clock difference as WebSocket latency.

Layout edits include panel settings, additions/removal, section state/order,
and table search/filter/column configuration. Hover, incoming observations,
table page offsets, Run selection, and URL time controls are not layout edits.
An undo to the saved configuration clears the dirty state. Switching or
resetting edited workspaces requires Save and continue, Discard changes, or
Cancel; unsuccessful saves cannot continue the destructive transition.
Deleting an active saved definition preserves the current panels as an
unsaved draft. Browser reload/close protection applies to unsaved layout edits.

### Native multi-run behavior

One or multiple selected Runs use the same layout and interactions:

- Selected Runs appear as removable, consistently colored labels.
- The same Run has the same color across every chart.
- Its selected-Run swatch and details drawer open a compact palette with a
  custom color picker and Automatic reset. Overrides apply across workspaces
  in that browser and never alter recorded Run configuration or another browser.
- Duplicate Run names gain the minimum experiment/project context needed to
  distinguish them, consistently across the selector, curves, and Run
  details. Registry names and IDs are never rewritten.
- The initial shared chart set uses compatible recorded fields and units.
- A metric absent from one Run is labeled **not recorded**, never zero.
- Start with at most four overlaid Runs for readability; larger comparisons
  should be deliberately grouped rather than silently overcrowded.
- Add or remove a Run without rebuilding chart instances, losing the metric
  set, resetting zoom, or silently changing the alignment axis.
- Share selection and range through `/rvx?runs=...`; separate Run-chart and
  Compare routes are not retained as compatibility destinations.

## 5. Charts must work before the user edits anything

A new Run must not open an empty board or ask the user for a JSON pointer.

The system provides a small initial chart set, normally four to six charts,
using a deterministic field catalog and known semantic groups:

- Training quality: loss, reward, KL, or another declared objective.
- Progress and throughput: samples, tokens, steps, or completed work.
- Asynchronous pipeline: queue depth, latency, utilization, or backlog.
- Resources: GPU, CPU, and memory when those observations exist.

Do not select the first arbitrary numeric fields in a large snapshot. Internal
IDs, schema versions, timestamps-as-values, and collector bookkeeping should
not become default charts.

The field catalog should expose a readable name, grouping, unit when known,
available role/Source scope, and the underlying field identity. JSON pointers
remain an internal identifier and an optional expert detail.

Units and aggregation must not be guessed. If several Sources publish a field,
use a declared primary Source or a documented aggregation. Otherwise show
separate labeled Source traces when requested. Never silently average values
whose semantics or weights are unknown.

## 6. Interaction model

### Normal path

The common path requires no board editor:

1. Read useful charts for the initial selection.
2. Toggle Runs to see their curves together, without navigation.
3. Change the shared range, hover, or zoom while fresh observations arrive.
4. Open a Run's details to read its execution identity and configuration.

### Adding charts, tables, and sections

**Add** is the single creation entry point for charts, metric tables, snapshot
views, and sections. These four types are explicit tabs, not a dropdown or a
multi-step setup wizard. Tabs use roving keyboard focus, arrow/Home/End
navigation, and one labelled content panel; changing tabs cancels old reads.
The editor separates selection on the left from real-data preview and display
settings on the right. Explicit **Add** or **Save changes** commits the draft;
Cancel, Escape, and outside dismissal leave the workspace unchanged.
Snapshot collection options show a short name with row count, followed by the
complete JSON Pointer. Paths remain visible without hover, wrap at path
separators, and distinguish identically named collections; root is marked
explicitly. These are paths within one stored state, not separate snapshots
or HTTP endpoints.

Within Snapshot, Table, Bar, and Status share the same collection, reporter
selection, search/filter definitions, and panel identity. Field mappings sit
beside the preview, not in another wizard. Existing table definitions keep
their canonical storage kind and behavior; an optional typed view contains
bar/status settings, while its absence still means Table.

Bars bind a category and up to eight numeric measures with explicit count,
sum, min, or max aggregation. Source/Run series stay separate; stacking combines
measures only within a Source, never different Runs. Category limits rank the
full filtered dataset, not the currently visible table page. Exact values
remain available in readouts even when drawing coordinates use floating point.

Status binds stable identity fields, a state field, and optional label/group/value
fields. Array position is not a task identity. Duplicate or absent identity
fields fail explicitly rather than merging tasks. Cells use semantic state
colors separately from Run colors; missing/null/unknown states and disappearing
records never imply successful completion. The first release is a current
state matrix, not a historical contribution calendar.

The Status toolbar's **Arrange** popover shares its controls with the Snapshot
editor: sort by a scalar field in either direction, choose automatic or fixed
columns, and tune cell size and spacing. Native field sorting applies before
paging over the complete filtered dataset, with stable task identities breaking
ties; each visible Run/Source/group retains that native order. No display-preview
string is used to re-sort exact numbers. Without a field sort, native source-fair
identity ordering remains in effect; retained Table sorting is independent.
Geometry-only edits do not fetch data. Columns and cell geometry adapt to narrow
viewports and the DOM budget without replacing saved preferences. Cells are flat
solid-color squares with a small corner radius: no decorative gradients,
highlights, bevels, or shadows. Hover changes only brightness; keyboard focus
uses a flat inset outline without shifting neighbours. Missing states use a
dashed outline, null states a center dot. Reduced-motion preferences disable transitions. All settings are workspace-owned
and persisted on the server.

**Shade by** optionally maps a numeric field to cell intensity while retaining
the status hue. The shared pinned state-count request also returns exact minima
and maxima across the full filtered dataset. Min measures also provide the exact
smallest nonzero magnitude. Sources and pages share one scale, defaulting to
signed logarithmic normalization so a large outlier does not compress common
values into the same shade. The transform is `sign(x) * log1p(abs(x) / a)`,
where `a` is that full-dataset smallest nonzero magnitude; zero and negative
values stay meaningful and changes of measurement units do not alter the scale.
**Scale** also offers Linear, and switching uses the cached coherent frame
without a new request. The chosen scale is identified beside flat shade swatches.
Close large integers and extreme decimal exponents are normalized in
bounded exact arithmetic before converting the final intensity to a drawing
coordinate. Constant fields use a uniform midpoint. Missing, null, nonnumeric,
or truncated values are not zero: a corner marker and hover readout identify
unavailable shading. The scale remains beside the state legend, and disabling
Shade by restores the original state-only colors.

Record pages and full-scope state counts must use the same immutable snapshot
IDs within a refresh. Large grids virtualize visible rows; pointer movement
does not rebuild the dataset. Task details are a bounded projection of that
record at its observed snapshot, not a download of the entire raw state.

Metric selection supports independent checkboxes, a clear selected count, and
selection retained across searches. Preview focus must not replace the selected
metric set. By default, multiple metrics create independent charts in one
operation. An explicit combined mode puts them in one chart; legends identify
metric, Run, and reporter. Incompatible units require independent labeled axes
or a clear refusal to combine, not an unlabeled mixed scale.

Available metrics use readable labels; search prioritizes direct name matches
over incidental path matches. Diagnostic and already-added fields stay
discoverable without crowding the primary choices. Compact metric names use
ordinary 12-13px text rather than oversized bold headings. Consecutive metric
rows and dropdown options have visible space between their hover/selection
backgrounds, not touching rounded rectangles. Units are shown once and are
not editable guesses.

Display settings include title, line/area presentation, line width, points,
legend visibility, normal/wide size, and optional Y bounds. Changes affect
presentation only: no implicit smoothing, averaging, transformed values, or
per-chart reassignment of Run colors. Preview reads use the same bounded
projection path and actual observation provenance as saved charts.
Unavailable numeric choices explain their data prerequisite without hiding
other valid Add types. Menus are exclusive and dismiss with Escape or an
outside click. Saved-set editing prefills the active name and labels
replacement explicitly.

Sections are shallow groups in the same scrolling workspace, not separate
pages or another workbench hierarchy. Users can create, name, rename, collapse,
and expand them. Panels can move within or between sections. Removing a
section must preserve its contents in another group unless deletion is
explicitly confirmed. A default group need not add another visible title.
Collapsed sections do not keep polling hidden panels.

Panels have stable identities independent of their metric paths. The same
metric may occur in an independent chart, a combined chart, and a table
without identity collisions. Named server-owned workspace sets retain
panel types, configuration, section membership/order, collapse state, and
panel order. There is one current typed format, not migration chains or
parallel old/new layout engines.

Direct dragging from the panel title changes order without reserving a
permanent left grip gutter. Keep a subtle grab affordance and keyboard
placement semantics, with visible drop
feedback and scrolling near workspace edges. Canvas dragging remains zoom,
not panel movement. Pointer/touch and keyboard operations support cancellation
without changing the saved order. Remove Move earlier/Move later menu actions;
they are not the primary arrangement interaction.

Fullscreen and display actions live in the panel's options menu instead
of permanently occupying each chart. Inspect is removed from both chart
menus and table rows, along with its drawer and frontend raw-snapshot reads.
The options glyph uses clearly visible,
centered filled dots. Fullscreen opens a viewport-sized chart or table.
Closing it restores the same canvas, zoom, selected observation, focus, and
workspace scroll. It must work on ordinary authenticated HTTP without requiring
secure-context-only browser Fullscreen APIs.

Use compact plot padding and useful plotting space rather than a padded
rounded-card composition. Remove the permanent footer/latest-value band.
Center the chart title and its unit within the card without reintroducing a
left grip gutter. Multiline date ticks need sufficient axis and canvas space;
do not crop their final date/year line or hide the problem with overflow.
The title and unit form one padded centered hover/drag target, not separate
tightly wrapped highlights. Use a consistent modest radius for charts and
tables. Table height should fit a short result set and stop growing at a
bounded maximum height; longer results scroll inside it.
Table headers use a compact title row, then an 8px gap to the tools and an
8px gap from the tools to the body. Updated freshness is grouped with Add
on the trailing toolbar edge, with matching vertical centers on all widths.
Use quiet surfaces and subtle dividers rather than outlining every item and
control. The selected metric should be apparent without a heavy blue box.
Keyboard focus uses localized background/text-color treatment, not underline
shadows or a large frame
around a whole chart or scrolling workspace. On small screens,
preview, settings, and the primary action must remain reachable without
stacking an entire desktop toolbox above the chart.

Remove nested board editing, layout JSON editing, arbitrary pane splitting,
preview/pin tab management, and multiple competing live controls. Flat sections
organize visible content without becoming prerequisites for seeing charts.

### Tables are first-class views of snapshot evidence

Two table types have distinct semantics:

| Type | Rows | Evidence and time model |
| --- | --- | --- |
| Metric table | Metric / Run / Source with current, minimum, average, P95, maximum, count and missing values | Statistics over all recorded numeric observations in the selected axis/range; never statistics of decimated chart points |
| Snapshot table | Records from an array, keyed object, scalar collection, or root snapshot fields | The selected complete snapshot for each Source, with its own observation time and immutable ID |

Both types support search, sortable columns, explicit filters, column selection,
column order and widths, a fixed header/key column, and bounded pagination.
Numeric columns also have Auto or 0-20 decimal places. Formatting rounds exact
decimal text for display only; raw values still drive filtering, sorting,
tooltips, and CSV export. Width/precision changes do not refetch snapshots.
Filters retain their definitions when disabled, can be re-enabled individually,
and can be edited rather than accumulating replacements. Only enabled
conditions participate in reads. Reuse collation and decoded numeric keys
instead of reparsing values inside every sort comparison.
Numeric sorting must remain numeric, including
exact 64-bit integer cells. Missing, null, empty strings, booleans, and truncated
container previews remain distinguishable.

Metric summaries never combine asynchronous Sources or Runs implicitly.
By default they follow the selected metrics' recorded publishers, matching
the reporter choices in the editor. They do not silently include unrelated
or retired registrations. Explicit reporter selections retain their own
missing-only and zero-observation rows.
Current is the value in the latest actual observation of the chosen range; an
absent/non-numeric latest field is missing, not a previous number carried
forward. P95 uses the documented nearest-rank definition over all numeric
observations. Exceeding a processing budget is an explicit error, not an
unlabeled approximation.

Snapshot-table search, filters, and sorting apply before pagination. Tables
refresh their latest source observations on the same cadence as charts, even
while the user is paging/filtering. Keep search, filters, sorting and page;
when a result shrinks, clamp the page to the last valid one. Pins may keep
one in-flight request/retry internally coherent but do not freeze the visible
table indefinitely. Different Source snapshots are not globally atomic.
There is no table Refresh/Use latest action, and no repeated "All indexed
observations - one row per Run/reporter/metric" subtitle.
Routine source-observation counts and collection-discovery explanations
do not occupy extra rows. Keep real errors and missing-data indications.
Ordinary background refresh keeps rows visible without flashing Loading or
rebuilding focused headers and column-resize handles.

Large cells are bounded previews with an explicit indication; complete snapshots
remain available through the APIs/CLI, not a table Inspect action.
If a CSV export contains only the current page,
give the compact export action the accessible name **Export page CSV**, not a
full-table export. All loading, retry,
unavailable-field, and empty states must fit the same compact table surface.

The current UI supports four selected Runs, 24 panels, 24 flat sections, and
75 rows per table page. Combined plots use one scale and reject differing
units; multiple Y axes are not implemented. Column controls use discovered
fields; arbitrary nested-column authoring remains an API capability rather
than an editor control. Wide tables scroll horizontally.

### Reading values and Run configuration

Hovering a curve opens a compact readout beside the pointer: a concise shared
X coordinate and colored Run/metric/reporter values. Avoid a repeated
"Nearest recorded observations" heading and full dates on every row.
Values still belong to actual nearest observations, not interpolated or
globally synchronized points. Show short per-row coordinates only when they
differ; missing values and outside-coverage states remain explicit.
Keyboard and touch interaction provide equivalent readouts.
Shorter traces explicitly report outside coverage rather than extending their
endpoint values. Live refresh and late size reconciliation preserve an active
readout. Large combined plots show a viewport-bounded window of at most twelve
trace rows with an explicit count; keyboard navigation keeps the selected trace
in that window without mounting or formatting every hidden row.

The Run drawer shows its name/status, full Run ID, project, experiment,
creation/update times, and configuration from registry metadata. It does not
fetch a state snapshot. Small configuration JSON is formatted with exact
integer lexemes; large or complex configurations have an explicit bounded
preview and a complete original JSON download. Invalid JSON is reported rather
than replaced with an empty object. Closing the drawer restores focus without
changing selection, zoom, range, layout, or saved/unsaved state.

Numeric projections retain actual observation IDs internally after sampling.
Left/right keys follow displayed coordinates, not hidden duplicate versions;
up/down moves between Run or reporter traces. Removing Inspect does not remove
or rewrite stored snapshots or their public API contracts.

## 7. Time, continuous refresh, and data truth

- The shared workspace defaults to elapsed observation time, explicitly labeled
  **since first observation**. Its origin is the earliest recorded observation
  for each Run, not registration time or an invented training start.
- This default is the same for one or multiple Runs. Changing selection does
  not change the axis. Observation wall time remains an explicit choice;
  the underlying numeric API retains its own wall-time default.
- If an alignment origin is unavailable, elapsed alignment is unavailable;
  do not silently substitute a different clock.
- Logical axes such as optimizer step remain available as an advanced choice.
  Their bounds use their own units, never observation nanoseconds.
- Quick ranges are **15m, 1h, 6h, 24h, 3d, 7d, All**, and **Custom**. Do not
  repeat "Last" or long duration phrases in the compact picker. Each duration
  round-trips through the URL and uses the same true query bounds.
- Custom elapsed bounds accept durations such as `30m` or `1h 15m`; wall-time
  bounds use local date/time controls, not hand-entered Unix nanoseconds.
  Clock inputs edit whole seconds, while unchanged existing bounds retain
  their original finer precision. Unsupported or silently rounded coordinates
  are rejected explicitly.
- Elapsed tick spacing uses readable duration intervals, without changing
  the underlying observation coordinates or resampling the data.
- There is no globally synchronized step or atomic snapshot across roles.

Missing fields and missing observations are different from zero. Known gaps
remain gaps after downsampling. Interleaved Source timestamps do not create
fake missing-field observations.

All visible charts and tables refresh continuously on one bounded cadence.
There is no pause mode or pause URL flag. Waiting for first data, stale
observations, empty selection, and request failure retain distinct concise
states. Keep the last successful chart
visible after a failed refresh and show its age. Do not replace it with an
empty success-looking chart.
Errors retain their HTTP status and readable server detail, without exposing
the native JSON transport wrapper or interpreting upstream HTML.
Observation age is assessed per selected Run; another Run's recent data must
not hide an old running Run. Hidden tabs suspend expensive reads, then resume
on visibility. Ordinary refresh does not clear rows, display a perpetual
loading label, or cancel an already active slow projection. Failures remain
visible with an explicit retry where needed, rather than success-shaped
fallback data.

## 8. Visual direction

The target is modern, minimal, spacious, and deliberately designed, not an
industrial control console. Replace the overall navigation, composition,
typography, and interaction model rather than applying another visual skin
to the existing workbench.

- Neutral light surfaces by default, with a coherent dark alternative.
- A restrained accent color and consistent Run colors.
- Clear typography and spacing hierarchy; readable labels take priority over
  maximum row count.
- Keep small Run-name text in the theme foreground rather than using trace
  hues as text colors. Swatches, checkboxes, and curves carry Run identity.
  Check enabled small text at 4.5:1 and essential trace colors at 3:1 against
  their actual surfaces in both themes.
- Use generous but purposeful spacing, a few clear visual groups, and light
  chart surfaces. Avoid dense border grids, tiny labels, and rigid toolbars
  around every region. Charts, not chrome, remain the dominant content.
- Chart titles name the metric and unit, not implementation details.
- Compact chart insets and minimal borders; avoid nested boxes, empty footer
  bands, repeated controls, and large focus outlines.
- No gradients, glow, oversized cards, large empty hero areas, decorative
  badges, or constant explanatory banners.
- Essential actions are visible and keyboard accessible, not discoverable
  only through hover or a command palette.
- Use a clearly weighted centered SVG options glyph, not faint font ellipses.
  Contextual actions belong inside its menu rather than surrounding every plot.

Desktop uses a responsive two- or three-column chart grid. Smaller screens
reduce columns using the actual space beside the Run selector, not viewport
width alone; narrow workspaces use one readable column and a compact shared
toolbar. Do not stack the desktop navigation, sidebar, tabs, panel controls,
and editors above the first mobile chart.

## 9. Performance architecture

Keep four clear responsibilities:

```text
Run selection / organizational filters
            |
Workspace: selected Runs, sections, panels, range, shared refresh
            |
Field/collection catalogs + bounded query coordinator
            |
Charts / tables + Run metadata/configuration drawer
```

All Run selections use the same chart components and query path.
Components own their observers, listeners, timers, and cancellation. Prefer
small, coherent responsibilities over a large shell class or a generic plugin
framework. Shared primitives belong below views, not inside another view.

Performance requirements:

- Fetch chart projections to draw charts; do not download full state documents
  merely to discover or render ordinary curves.
- Render and refresh visible charts first. Offscreen charts must not consume
  the same resources as the active viewport.
- Batch compatible queries, deduplicate concurrent reads, and cancel stale
  requests when scope changes.
- Preserve chart instances and interactions during normal refresh.
- Bound retained data by bytes as well as entry count; actually release expired
  caches and suspend polling in hidden pages.
- Virtualize large Run lists and bound configuration previews without rendering
  large object trees. Download original configuration text only on demand.
- Discover table collections through a bounded catalog, and request only the
  selected columns/page. Do not poll full raw snapshots to render table cells.
- Compute full-range metric statistics from the snapshot-derived numeric index,
  separately from chart decimation. Return explicit budget errors.
- Expanding, reordering, or regrouping a panel does not recreate its renderer
  or duplicate its polling ownership.
- Cursor readouts reuse the fetched bounded projections; they do not request
  raw snapshots. Coalesce pointer work to animation frames and avoid rebuilding
  unchanged tooltip content on every mouse event.
- Compute saved-layout comparisons at configuration mutations, not during
  polling, pointer movement, or chart rendering. Publish saved metadata only
  after the server transaction accepts the write. A later edit while saving
  remains dirty relative to the exact submitted layout.
- Separate shared-workspace revisions from per-browser preference revisions.
  Coalesce pointer-move resize changes and serialize preference writes; do not
  send server updates on every drag frame.
- Keep one bounded WebSocket heartbeat owner; timeout stale connections,
  reconnect with backoff, and clean up sockets and timers on teardown.

The backend maintains a bounded, rebuildable numeric index derived from
snapshots. This does not introduce another write/log channel or replace the
snapshot source of truth.

Proposed acceptance workload: a 10,000-Run browser and six visible charts with
up to four compared Runs and 2,000 rendered points per trace. Target responsive
input handling within one frame and no repeated steady-state tasks over 50 ms.
Measure network, query, and rendering cost separately; these are design targets,
not claims that the new design has already met them.

## 10. Pre-alpha policy: delete legacy and compatibility

RVX is in **very early development**, not a stable production platform.
API, storage, configuration, and UI formats may change without compatibility
guarantees. Do not preserve an obsolete architecture merely to avoid breaking
an early development setup.

| Remove from the target | Keep |
| --- | --- |
| Old `/ryx` routes and brand aliases | Canonical RVX routes and naming |
| Browser preference/layout migration chains | One current, typed workspace-set format with explicit obsolete-format feedback |
| Legacy numeric-history UI and `legacy-query` | Snapshot-derived numeric queries |
| Old metric WAL/Parquet reader/writer compatibility paths and their fixtures | Current complete snapshot storage and history |
| Nested Board/Section/Panel workbench and split-tab compatibility | One workspace with shallow optional sections and chart/table panels |
| Special mirrored hostmon dashboards and administration bridges | Hostmon as an ordinary snapshot producer, if needed |
| Parallel old/new UIs, compatibility flags, and unused renderers | One maintained implementation |

Keep authentication, origin checks, bounded buffers/queries, retention-gap
reporting, exact raw values, and explicit failure handling. They are correctness
and access boundaries, not legacy features.

Deleting compatibility code is not permission to silently delete user data.
Before a breaking storage replacement, identify the affected files, preserve
an explicit backup if required, and choose a clean data directory deliberately.
Do not maintain runtime importers or fallback readers solely for that backup.
Unchanged current snapshot data can remain in use without creating a
compatibility layer.

## 11. Delivery sequence and acceptance

1. Keep shared Run selection and stable time alignment across all panel types.
2. Add multi-metric batch/combined creation and both evidence-backed table types.
3. Add shallow sections, direct dragging, fullscreen views, and persisted layout.
4. Remove the superseded UI and compatibility paths; do not leave a hidden
   alternate workbench behind.
5. Exercise the complete workflow with representative asynchronous-role data.

The redesign is successful when:

- A new user sees useful curves after opening a Run, without first learning
  Source, Session, Board, or JSON-pointer concepts.
- Toggling Runs immediately updates overlays without a Compare action or navigation.
- Adding a chart requires a metric choice, not constructing a layout hierarchy.
- Multiple metrics can be selected across searches and added together.
- Table counts and statistics come from complete selected data, not visible
  pages or sampled chart points.
- Hovering consecutive list items shows separate target backgrounds; options
  are legible and centered, and multiple Runs can be read at the cursor.
- Header identity and persistence status match the actual working layout,
  including storage failure, undo, switching, and transient table browsing.
- Dragging or expanding preserves renderer identity, evidence selection, and
  analytical context; keyboard and touch have equivalent usable operations.
- Run identity and configuration remain accessible without losing chart context.
- Layout and refresh stay stable on desktop and mobile.
- Missing data, stale data, and failures remain honest.

**The product is the analysis workflow, not the configuration framework.**
