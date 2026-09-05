# RVX UI Design

Status: Snapshot-first design specification

This document defines the intended interface, not a claim that every optional
workspace convenience is implemented. The snapshot-first refactor applies its
industrial direction to structured state inspection, history, diffs, and field
projections. Current behavior is described in the README.

## Direction

RVX should look and behave like an industrial experiment and operations
console, not a decorative SaaS dashboard.

- Use neutral graphite and steel colors with low saturation.
- Organize information through spacing, contrast, and one-pixel separators.
- Avoid gradients, glow, glass effects, large shadows, and oversized rounding.
- Reserve color for selection, lifecycle state, warnings, and failures.
- Keep the interface dense without rendering every object as the same table.

## Application structure

```text
+----------------------------------------------------------------+
| Global Header: path / search / axis / connection state          |
+------+-----------------+----------------------------------------+
| Rail | Navigator       | Main Canvas                            |
| 52px | 220-300px       | Browser Page or Run Workspace          |
|      | resizable       |                                        |
+------+-----------------+----------------------------------------+
| Status Bar: live / sources / snapshots / gaps / failures       |
+----------------------------------------------------------------+
```

### App Rail

The App Rail owns only global destinations:

- Projects
- Runs
- System

Use compact line icons with text labels on desktop and icons only on narrow
screens. Do not use single-letter navigation buttons.

### Context Navigator

The Context Navigator shows only the current scope:

- Projects within the global registry.
- Experiments within a Project.
- Runs within an Experiment.
- Available analytical Views within a Run Workspace.

It is resizable on desktop and becomes an overlay drawer on narrow screens.
It must not duplicate global navigation or analytical Tabs.

### Main Canvas

The Main Canvas renders either:

- a Browser page for locating and selecting objects; or
- a Workspace for analyzing one or more Runs.

Project, Experiment, Runs, and System pages never become Tabs. Tabs exist only
inside a Run or Compare Workspace.

### Status Bar

The Status Bar contains compact read-only operational state:

- connection dot
- active and total Sources
- durable snapshots
- snapshot storage state
- explicitly labeled legacy storage counters when relevant
- cursor gaps
- scrape failures

Do not place configuration or layout controls in the Status Bar.

## Browser pages

### Projects

Render Projects as a compact registry:

```text
Project      Experiments  Runs  Active  Failed  Sources  Updated
hostmon      1            1     1       0       2        10s ago
async-rl     8            126   14      3       240      2s ago
```

The page begins with one compact summary row containing Projects, Runs,
Active, Failed, and Sources. Avoid large marketing headers and oversized
Project cards.

### Project

Use three responsibility-based regions:

1. Experiments
2. Active Runs
3. Attention

Experiment rows show Run count, active count, failed count, Source count,
resource summary, and last update. Attention contains only actionable
failures, stale Sources, lost Sources, and data-quality problems.

### Experiment

Use this order:

1. Compact summary row: Runs, Active, Finished, Failed, and Sources.
2. Compact state freshness and data-quality summary.
3. Virtualized Runs table.
4. Collapsible Parameters section.
5. Collapsible Failures and Data Quality section.

Selected numeric field projections may appear as compact inline statistics,
not independent metric cards. The Runs table is the primary surface.

### Runs

The global Runs page is a search and selection workbench:

- one-line advanced query input
- full-height virtualized table
- fixed identity and status columns
- dynamic parameter columns
- sorting and multi-selection
- custom context menu

Selecting two or more Runs opens a Compare Workspace directly.

### System

System is an operational page, not a generic settings page. Show snapshot
storage and collection, Source health, gaps, and failures. Old metric WAL and
Parquet counters must be explicitly labeled legacy rather than confused with
new snapshot persistence.

## Run Workspace

```text
Run identity / status / sources / updated
---------------------------------------------------------------
[Snapshots] [History] [Changes] [Field trends] [Sources]
---------------------------------------------------------------
Section
+--------------------------+--------------------------+
| Chart or Table           | Chart or Table           |
+--------------------------+--------------------------+
```

### Workspace header

The Workspace header owns:

- Run or Compare identity
- Browser return path
- global View search
- one axis selector

Do not repeat the axis selector inside individual Views.

### Tabs

Each Tab is one analytical View instance. Tabs support preview, pin, close,
duplicate, restore, and split-pane movement.

- Height: 28 pixels.
- Use a restrained active indicator.
- Avoid oversized text and decorative Tab shapes.
- Keep close controls hidden until hover or activation.

### Sections and panels

Numeric field-projection Views may use persistent Sections.

- A Section controls one, two, or three columns.
- A Section controls one shared panel height.
- Individual panels cannot resize independently.
- One panel spans the full Section width.
- Empty Sections collapse to a compact add-panel state.

Chart and Table panels share the same title bar, actions, border, and spacing.

### Snapshot inspection

The primary state View contains:

1. compact Run lifecycle and Source freshness summary
2. Source-local Session, snapshot version, schema version, and observation time
3. structured state, including objects, arrays, text, booleans, and null
4. historical version selection and page-by-page replay
5. added, removed, and changed fields between selected versions
6. optional numeric field trends selected by JSON pointer

Cross-Run comparison uses the same state and field projection operations.
There is no independent metric log. A missing or nonnumeric field is a gap,
never a carried-forward value. Large JSON previews and diffs must explicitly
indicate truncation. Combining Sources by time does not mean their observations
were globally atomic.

Historical `ended` Sources do not degrade Pipeline health. Only stale,
errored, or lost operational Sources should produce warnings.

### Pipeline

Pipeline is grouped by ML role and reports:

- Sources
- Active
- Stale
- Nodes
- Failures
- Health

Health vocabulary is `OK`, `WAITING`, `WARN`, `DOWN`, and `ENDED`.

### Sources

Sources use a dense table with state, role, rank, node, PID, endpoint, session,
interval, and error. Source details open as a normal Workspace View rather
than a global Inspector panel.

### Run Details

Run Details contains stable identity, lifecycle timestamps, Source counts,
resolved configuration, and hostmon operational navigation. Long JSON uses a
monospace code surface and must not dominate the initial viewport.

## Visual specification

| Element | Specification |
| --- | --- |
| Background | `#0b0e12` and `#11161d` |
| Raised surface | `#151b23` |
| Separator | `#2b333d` |
| Primary text | `#e6e9ed` |
| Secondary text | `#8e98a5` |
| Selection | Low-saturation steel blue |
| Running | Green, limited to state indicators |
| Warning | Amber |
| Failure | Red |
| Radius | 0-4 pixels |
| Spacing scale | 4 and 8 pixels |
| UI text | 12-13 pixel sans-serif |
| Metrics and IDs | 11 pixel monospace |
| Tab height | 28 pixels |
| Table row height | 26-28 pixels |
| Header height | 40 pixels |

Use tabular numerals for metric values. Use sans-serif for navigation,
hierarchy, labels, and descriptions. Reserve monospace for metrics, IDs,
timestamps, configuration, and table values.

## Responsive behavior

### Desktop

- Rail, Navigator, and Main Canvas are visible.
- Navigator width is adjustable.
- Workspace may show two panes.
- Tables remain virtualized and horizontally scroll only when required.

### Tablet

- Narrow the Rail and Navigator.
- Use one chart column when the content width becomes insufficient.
- Preserve the table header and important identity columns.

### Mobile

- Show icon-only App Rail.
- Replace the Navigator with a `Views` overlay drawer.
- Show only the focused Workspace pane.
- Stack summary values and panels.
- Preserve global search, axis selection, and status visibility.
- Never introduce document-level horizontal scrolling.

## Interaction rules

- Single click selects or previews.
- Double click enters a Run Workspace.
- Right click opens the RVX context menu.
- Hover reveals only relevant actions.
- `Ctrl+P` focuses contextual search.
- `Ctrl+W` closes the active analytical Tab.
- `Escape` closes menus, drawers, and dialogs.

Periodic refresh must update charts and tables in place. It must not rebuild
the Workspace, destroy scroll position, reset selection, or flicker charts.

## Remove from the current design

- Decorative gradients, glow, glass effects, and large shadows.
- Large page titles and marketing-style descriptions.
- Large metric and Project cards.
- Single-letter navigation.
- Duplicate path, axis, status, or object identity controls.
- Empty Sections that consume substantial Canvas space.
- Rounded cards around every region.
- Unrelated hover abbreviations or floating controls.
- Black text on dark surfaces.

## Acceptance

Every UI change requires:

1. strict TypeScript build
2. frontend unit tests
3. browser E2E tests
4. desktop screenshots for Projects, Project, Experiment, Runs, and Workspace
5. mobile screenshots for Browser, Workspace, and Navigator drawer
6. visual inspection for hierarchy, density, contrast, clipping, overlap, and
   unnecessary whitespace

The redesign is accepted only when behavior remains stable, document-level
horizontal overflow is absent, charts update in place, and screenshots match
the industrial high-density direction above.
