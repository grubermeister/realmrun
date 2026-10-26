# Planet snapshot viewer

A static, read-only browser page for the JSON that
`realmrun --scenario planet-evolve --export-snapshots` writes
([format version 1](../README.md#snapshot-export-format-version-1)). It shows
the planet **as saved** at each checkpoint: the baseline at 0 ms beside one
selected checkpoint, on one of four layers, with a legend, counts, the
difference from the baseline, and the recorded events.

It is a development instrument, not a game client. It never runs, advances,
or interpolates the simulation, and it never invents a planet: a file that
fails validation is refused whole. It needs no database, `DATABASE_URL`, or
running service, and it makes no network requests apart from loading its own
three static files. A Content-Security-Policy in `index.html` enforces that.

Plain HTML, CSS, TypeScript, and Canvas 2D, bundled by Bun. It has no
frontend dependencies and does not import realmlib or the module packages.

## Demonstration

```sh
# From realmrun, with a disposable realmrun_* PostgreSQL development database
# and the existing .env / DATABASE_URL configured:
bun run db:reset
bun run start --scenario planet-evolve --seed 1729 --sea-level 0 \
  --mean-temp 15 --until 2000 --export-snapshots ./planet-evolution.json

bun run viewer:build
python3 -m http.server 8000 --directory viewer
```

Open `http://localhost:8000/` and choose `planet-evolution.json` (at the
repository root; it is gitignored) with the file picker. The file is read in
the browser and is not uploaded; the server only serves the viewer's files.
Any static file server works. Opening `index.html` straight from disk does
not, because browsers refuse module scripts from `file://` URLs.

For that file, the viewer opens on **Biomes** at the latest checkpoint:

| Checkpoint | Sea level | Land cells | Ocean cells | Event |
|---|---:|---:|---:|---|
| 0 ms (baseline) | 0 | 695 | 457 | sea-level-rise lies after it |
| 1000 ms | 10 | 508 | 644 | reflected |
| 2000 ms | 10 | 508 | 644 | reflected; maps identical to 1000 ms |

Against the baseline, 187 cells are newly flooded, none emerge, and 387 cells
carry a different saved biome label (for example 69 forest → ocean and
67 desert → grassland).

## What it shows

- **Layers.** *Terrain / elevation* draws `terrain.elevation` in two fixed
  ramps, water (elevation ≤ that checkpoint's `terrain.seaLevel`) and land.
  The saved elevations never change, but cells drawn as land at 0 ms are
  drawn as water once the sea has risen. *Temperature* draws
  `climate.temperatureC` on a fixed −40 to 40 °C ramp: colder or hotter cells
  take the end colours, though records allow −100 to 100. *Moisture* draws
  `climate.moisture` on a fixed 0 to 100 ramp. *Biomes* draws `climate.biome`
  with one colour for each of the seven biomes.
  No scale is fitted to the data, so one value always has one colour.
- **Maps.** One canvas pixel per cell, scaled up without smoothing at a fixed
  2:1 ratio. Row 0 (north) is at the top and columns run west to east once
  around the planet. The left and right edges are neighbours, and no seam
  column is repeated. Pointing at a cell shows its saved values in both
  checkpoints.
- **Checkpoints.** One button for each saved `atMs` and nothing in between.
  The arrow keys move between them, as with any radio group.
- **Statistics.** Land and ocean counts, temperature and moisture ranges and
  means, and biome counts for the baseline and the selected checkpoint, plus
  the difference between them. Shares are percentages of the 1152 raster
  cells, **not** of the planet's area, because the grid is not equal-area.
- **Events.** The file's `events` as saved, each marked as reflected in the
  selected checkpoint or after it. A run that stops before 1000 ms shows
  “No recorded events”. The viewer never infers an event from changed
  numbers.

## Validation

[`src/snapshot-format.ts`](src/snapshot-format.ts) accepts only format version 1
of `planet-evolve`. It checks:

- the exact envelope, config, and grid (48 × 24, row-major, north to south,
  wrapping);
- each record's schema version, fields, 1152-cell arrays, value ranges, and
  biome names;
- snapshot times that start at 0 and ascend strictly;
- the config's seed and baseline temperature in every record;
- `ocean` biomes on exactly the cells that terrain puts at or below sea level;
- that the one `sea-level-rise` event is recorded exactly when there is a
  checkpoint at 1000 ms, with the configured levels, and that every
  checkpoint's sea level agrees with it.

The first problem found is shown on the page, for example
`snapshots[1].climate.biome[7] must be one of ocean, …, found "swamp"`. The
previous file's maps are cleared and nothing else is drawn. The loaded bundle
is frozen, and file contents only reach the page as text.

## Development

```sh
bun run viewer:build      # bundles src/main.ts into dist/main.js (gitignored)
bun run viewer:typecheck  # DOM-enabled strict check of viewer/src
bun test                  # includes tests/viewer-*.test.ts
```

The tests build genuine bundles with D1's own in-memory run, bundle builder,
and serializer. They cover parsing and rejection, raster orientation and
layer sources, fixed scales, and the counts and differences above. They do
not drive a browser.

## Known limits

- Only format version 1, the `planet-evolve` scenario, and the fixed
  48 × 24 grid are supported. Anything else is refused rather than guessed at.
- The baseline is always the 0 ms checkpoint. There is no zoom, pan,
  projection, animation, or export.
- Colours are fixed for this toy model's ranges and have not been tuned for
  colour-vision deficiencies beyond keeping water and land ramps disjoint.
  Exact values are always available from the cell inspector and tables.
