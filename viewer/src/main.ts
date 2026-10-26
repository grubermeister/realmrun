/**
 * The viewer page: reads one chosen file in the browser, validates it, and
 * shows its baseline and a selected saved checkpoint side by side. The only
 * state is the loaded bundle and the chosen layer and checkpoint; the bundle
 * is frozen, and every number shown is read or counted from it. No network
 * requests are made, and file contents only ever reach the page as text.
 */

import { cellAt, DEFAULT_LAYER, LAYERS, legendFor, rasterPixels, rowLatitude, scaleRamp } from "./map.ts";
import type { LayerId, Rgb } from "./map.ts";
import { cellShare, compareSnapshots, eventsRelativeTo, latestCheckpointIndex, summarize } from "./metrics.ts";
import type { ValueSummary } from "./metrics.ts";
import { BIOMES, GRID_HEIGHT, GRID_WIDTH, isWater, parseSnapshotFile } from "./snapshot-format.ts";
import type { Snapshot, SnapshotBundle } from "./snapshot-format.ts";

interface Loaded {
  readonly bundle: SnapshotBundle;
  readonly fileName: string;
  layer: LayerId;
  checkpoint: number;
}

let loaded: Loaded | null = null;
/** Increases with every file chosen, so a slow read cannot overwrite a later choice. */
let generation = 0;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`viewer page is missing #${id}`);
  return element as T;
}

const fileInput = byId<HTMLInputElement>("file");
const status = byId<HTMLParagraphElement>("status");
const view = byId<HTMLElement>("view");
const baselineMap = byId<HTMLCanvasElement>("baseline-map");
const selectedMap = byId<HTMLCanvasElement>("selected-map");
const inspector = byId<HTMLParagraphElement>("inspector");
const INSPECTOR_PROMPT = inspector.textContent ?? "";

/** A new `tag` element with `className` and children; strings become text nodes, never markup. */
function h(tag: string, className: string | null, ...children: (Node | string)[]): HTMLElement {
  const element = document.createElement(tag);
  if (className !== null) element.className = className;
  element.append(...children);
  return element;
}

const rgb = ([r, g, b]: Rgb): string => `rgb(${r}, ${g}, ${b})`;
const fixed = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const latitude = (row: number): string => {
  const value = rowLatitude(row);
  return `${Math.abs(value).toFixed(2)}°${value > 0 ? "N" : "S"}`;
};
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function showStatus(message: string, isError = false): void {
  status.textContent = message;
  status.classList.toggle("error", isError);
  status.setAttribute("role", isError ? "alert" : "status");
}

/** Hides everything from the previous file, so nothing stale looks loaded. */
function clearView(): void {
  loaded = null;
  view.hidden = true;
  for (const canvas of [baselineMap, selectedMap]) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  for (const id of ["source-details", "baseline-caption", "selected-caption", "layers", "checkpoints", "legend", "difference", "events", "metrics"]) {
    byId(id).replaceChildren();
  }
  inspector.textContent = INSPECTOR_PROMPT;
}

fileInput.addEventListener("change", async () => {
  const current = ++generation;
  clearView();
  const file = fileInput.files?.[0];
  if (file === undefined) {
    showStatus("No file loaded. Choose a lattice.planet.snapshots file (format version 1) exported by realmrun.");
    return;
  }
  showStatus(`Reading “${file.name}”…`);
  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    if (current === generation) showStatus(`Could not read “${file.name}”: ${errorMessage(error)}. No planet is shown.`, true);
    return;
  }
  if (current !== generation) return;
  let bundle: SnapshotBundle;
  try {
    bundle = parseSnapshotFile(text);
  } catch (error) {
    showStatus(`Not loaded: “${file.name}” is not a valid planet snapshot file: ${errorMessage(error)}. No planet is shown.`, true);
    return;
  }
  loaded = { bundle, fileName: file.name, layer: DEFAULT_LAYER, checkpoint: latestCheckpointIndex(bundle) };
  showStatus(`Loaded “${file.name}”: ${bundle.snapshots.length} saved checkpoint${bundle.snapshots.length === 1 ? "" : "s"}.`);
  buildControls(loaded);
  render(loaded);
  view.hidden = false;
});

/** A group of radio buttons named `name`, one per option, calling `choose` with the chosen value. */
function radioGroup<T>(container: HTMLElement, name: string, options: readonly { value: T; label: string }[], checked: T, choose: (value: T) => void): void {
  container.replaceChildren(
    ...options.map(({ value, label }) => {
      const input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.checked = value === checked;
      input.addEventListener("change", () => {
        if (input.checked) choose(value);
      });
      return h("label", null, input, h("span", null, label));
    }),
  );
}

function buildControls(state: Loaded): void {
  radioGroup(
    byId("layers"),
    "layer",
    LAYERS.map(({ id, label }) => ({ value: id, label })),
    state.layer,
    (layer) => {
      state.layer = layer;
      render(state);
    },
  );
  radioGroup(
    byId("checkpoints"),
    "checkpoint",
    state.bundle.snapshots.map((snapshot, index) => ({ value: index, label: String(snapshot.atMs) })),
    state.checkpoint,
    (checkpoint) => {
      state.checkpoint = checkpoint;
      render(state);
    },
  );
}

function drawMap(canvas: HTMLCanvasElement, snapshot: Snapshot, layer: LayerId): void {
  canvas.getContext("2d")!.putImageData(new ImageData(rasterPixels(snapshot, layer), GRID_WIDTH, GRID_HEIGHT), 0, 0);
}

function render(state: Loaded): void {
  const { bundle, layer } = state;
  const baseline = bundle.snapshots[0]!;
  const selected = bundle.snapshots[state.checkpoint]!;
  const layerLabel = LAYERS.find((entry) => entry.id === layer)!.label;

  const { config } = bundle;
  byId("source-details").replaceChildren(
    ...(
      [
        ["File", state.fileName],
        ["Format", `${bundle.format} v${bundle.formatVersion}`],
        ["Scenario", bundle.scenario],
        ["Seed", String(config.seed)],
        ["Starting sea level", String(config.initialSeaLevel)],
        ["Climate baseline", `${config.meanTempC} °C`],
        ["Configured rise", `+${config.seaLevelRise} at ${config.seaLevelChangeAtMs} ms`],
        ["Saved checkpoints", `${bundle.snapshots.map((snapshot) => snapshot.atMs).join(", ")} ms`],
      ] as const
    ).map(([term, value]) => h("div", null, h("dt", null, term), h("dd", null, value))),
  );

  byId("baseline-caption").textContent = `Baseline: ${baseline.atMs} ms · sea level ${baseline.terrain.seaLevel} · ${layerLabel}`;
  byId("selected-caption").textContent = `Selected: ${selected.atMs} ms · sea level ${selected.terrain.seaLevel} · ${layerLabel}`;
  drawMap(baselineMap, baseline, layer);
  drawMap(selectedMap, selected, layer);

  renderLegend(layer);
  renderDifference(baseline, selected);
  renderEvents(bundle, selected);
  renderMetrics(baseline, selected);
}

function renderLegend(layer: LayerId): void {
  const legend = legendFor(layer);
  const parts: HTMLElement[] = [];
  if (legend.kind === "categories") {
    parts.push(
      h(
        "ul",
        "swatches",
        ...legend.categories.map(({ label, color }) => {
          const swatch = h("span", "swatch");
          swatch.style.backgroundColor = rgb(color);
          return h("li", null, swatch, label);
        }),
      ),
    );
  } else {
    for (const scale of legend.scales) {
      const width = 201;
      const ramp = document.createElement("canvas");
      ramp.width = width;
      ramp.height = 1;
      ramp.getContext("2d")!.putImageData(new ImageData(scaleRamp(scale, width), width, 1), 0, 0);
      const low = scale.stops[0]![0];
      const high = scale.stops.at(-1)![0];
      const ticks = h(
        "div",
        "ticks",
        ...scale.stops.map(([value]) => {
          const tick = h("span", null, String(value));
          tick.style.left = `${((value - low) / (high - low)) * 100}%`;
          return tick;
        }),
      );
      parts.push(h("div", "ramp", h("p", null, `${scale.label}, ${scale.unit}`), ramp, ticks));
    }
  }
  parts.push(h("p", "note", legend.note));
  byId("legend").replaceChildren(...parts);
}

function renderDifference(baseline: Snapshot, selected: Snapshot): void {
  const difference = compareSnapshots(baseline, selected);
  const span = `${baseline.atMs} → ${selected.atMs} ms`;
  const row = (label: string, count: number) =>
    h("tr", null, h("th", null, label), h("td", "number", String(count)), h("td", "number", cellShare(count)));
  const parts: HTMLElement[] = [
    h("p", null, `Selected checkpoint compared with the baseline, ${span}.`),
    h(
      "table",
      null,
      h("thead", null, h("tr", null, h("th", null, "Change"), h("th", "number", "Cells"), h("th", "number", "Of raster"))),
      h(
        "tbody",
        null,
        row("Newly flooded (land → water)", difference.flooded),
        row("Newly emerged (water → land)", difference.emerged),
        row("Biome label differs", difference.biomeChanged),
      ),
    ),
  ];
  if (difference.transitions.length > 0) {
    parts.push(
      h("p", "note", "Biome changes, from baseline to selected:"),
      h(
        "div",
        "table-scroll",
        h(
          "table",
          null,
          h("tbody", null, ...difference.transitions.map(({ from, to, cells }) => h("tr", null, h("td", null, `${from} → ${to}`), h("td", "number", String(cells))))),
        ),
      ),
    );
  } else if (baseline === selected) {
    parts.push(h("p", "note", "The baseline is selected, so it is compared with itself."));
  }
  byId("difference").replaceChildren(...parts);
}

function renderEvents(bundle: SnapshotBundle, selected: Snapshot): void {
  const events = eventsRelativeTo(bundle, selected.atMs);
  if (events.length === 0) {
    byId("events").replaceChildren(h("p", null, "No recorded events."));
    return;
  }
  byId("events").replaceChildren(
    h(
      "ul",
      "events",
      ...events.map(({ event, reflected }) =>
        h(
          "li",
          null,
          h("strong", null, `${event.atMs} ms: ${event.kind}`),
          h("br", null),
          `Sea level ${event.fromSeaLevel} → ${event.toSeaLevel}; consequence: ${event.consequence}`,
          h("br", null),
          reflected
            ? h("span", "tag", `Reflected in the selected ${selected.atMs} ms checkpoint`)
            : h("span", "tag later", `After the selected ${selected.atMs} ms checkpoint: not in its map`),
        ),
      ),
    ),
    h("p", "note", "Events are shown as saved in the file; the viewer never infers one from changed numbers."),
  );
}

function renderMetrics(baseline: Snapshot, selected: Snapshot): void {
  const before = summarize(baseline);
  const after = summarize(selected);
  const counted = (count: number) => `${count} (${cellShare(count)})`;
  const range = (summary: ValueSummary) => `${summary.min} / ${fixed(summary.mean)} / ${summary.max}`;
  const landMean = (summary: ValueSummary) => (summary.landMean === null ? "no land" : fixed(summary.landMean));
  const row = (label: string, left: string, right: string) => h("tr", null, h("th", null, label), h("td", "number", left), h("td", "number", right));
  byId("metrics").replaceChildren(
    h(
      "div",
      "table-scroll",
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h("tr", null, h("th", null, "Measure"), h("th", "number", `Baseline, ${baseline.atMs} ms`), h("th", "number", `Selected, ${selected.atMs} ms`)),
        ),
        h(
          "tbody",
          null,
          row("Sea level", String(baseline.terrain.seaLevel), String(selected.terrain.seaLevel)),
          row("Land cells", counted(before.land), counted(after.land)),
          row("Ocean cells", counted(before.ocean), counted(after.ocean)),
          row("Temperature min / mean / max, °C", range(before.temperatureC), range(after.temperatureC)),
          row("Temperature mean over land, °C", landMean(before.temperatureC), landMean(after.temperatureC)),
          row("Moisture min / mean / max", range(before.moisture), range(after.moisture)),
          row("Moisture mean over land", landMean(before.moisture), landMean(after.moisture)),
          ...BIOMES.map((biome) => row(`Biome: ${biome}`, counted(before.biomes[biome]), counted(after.biomes[biome]))),
        ),
      ),
    ),
  );
}

/** One cell's saved values in `snapshot`. */
function describeCell(label: string, snapshot: Snapshot, index: number): string {
  const { terrain, climate } = snapshot;
  return (
    `${label} ${snapshot.atMs} ms: elevation ${terrain.elevation[index]} vs sea level ${terrain.seaLevel} (${isWater(terrain, index) ? "water" : "land"}), ` +
    `${climate.temperatureC[index]} °C, moisture ${climate.moisture[index]}, ${climate.biome[index]}`
  );
}

for (const canvas of [baselineMap, selectedMap]) {
  canvas.addEventListener("pointermove", (event) => {
    if (loaded === null) return;
    const box = canvas.getBoundingClientRect();
    const { row, column, index } = cellAt(event.clientX - box.left, event.clientY - box.top, box.width, box.height);
    const baseline = loaded.bundle.snapshots[0]!;
    const selected = loaded.bundle.snapshots[loaded.checkpoint]!;
    inspector.replaceChildren(
      `Row ${row}, column ${column} (cell ${index}, ${latitude(row)})`,
      h("br", null),
      describeCell("Baseline", baseline, index),
      h("br", null),
      describeCell("Selected", selected, index),
    );
  });
  canvas.addEventListener("pointerleave", () => {
    inspector.textContent = INSPECTOR_PROMPT;
  });
}
