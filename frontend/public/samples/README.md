# Piano samples (not in git)

`AudioEngine` loads the grand piano from same-origin `/samples/splendid-grand-piano/`
instead of the upstream GitHub Pages CDN — the CDN is too slow on some networks, and
playback waits for every sample before starting.

The folder holds 226 `.ogg` files (~20 MB) from the free *Splendid Grand Piano* SFZ
instrument, served by <https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples>.
They are deployment assets and are intentionally not committed here.

To restore them on a fresh clone, download every sample name used by `smplr`'s
`SplendidGrandPiano` (the layer table is embedded in `node_modules/smplr/dist/index.js`)
into `splendid-grand-piano/`, keeping the original file names (spaces and `#` included),
e.g. `FF A#2.ogg`, `PP C4.ogg`.
