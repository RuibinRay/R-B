# R&B — Ray and Beat

A music production studio that runs in the browser: play and sequence instruments, turn a hummed
melody into notes, split a song into stems, record, arrange, mix, master and export.

Everything except stem separation runs entirely in the browser. Projects and recordings are stored
locally (IndexedDB); nothing is uploaded unless you point the stem separator at a server.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks and builds a static site into `dist/` |
| `npm run preview` | Serves the built site locally |
| `npm run fetch-samples` | Optional. Copies the instrument samples into `public/samples` so the site needs no CDN |
| `npm run copy-model` | Re-copies the Basic Pitch model into `public/models` (already done) |

Use a recent Chrome, Edge, Firefox or Safari. Recording needs `https://` or `localhost`.

## The stem separation server (optional)

The Demucs model is too large for a browser tab, so the **AI Stem Separator** page talks to a small
FastAPI server in `server/`. Python 3.9+ and `ffmpeg` on the PATH are required.

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt        # PyTorch + Demucs, several hundred MB
uvicorn main:app --port 8000
```

The first separation downloads the model weights (about 80 MB each for the 2/4-stem and 6-stem
models). On a laptop CPU expect roughly the length of the song or more per job.

Settings (environment variables): `RNB_MAX_MB` (upload limit, default 100), `RNB_MAX_MINUTES`
(default 10), `RNB_DEVICE` (`cpu`, `cuda`, `mps`), `RNB_ALLOWED_ORIGINS` (comma-separated front-end
origins allowed by CORS when the site is not on localhost), `RNB_WORK_DIR`.

Uploads are stored under a random job folder, never under the client's file name, processed one at
a time, and deleted when the stems have been downloaded or after an hour.

The front end looks for the server at `http://localhost:8000`; change it on the page, or set
`VITE_API_URL` at build time.

## What is in it

- **Music Composer** – 186 instruments in nine groups, each limited to its real range: 128 sampled
  (the whole General MIDI set), 23 synthesizers, 27 modeled instruments computed in the browser
  (plucked strings, bells and bars, drawbar organs, lush pads, sound effects such as risers and
  impacts) and 8 drum kits (studio, rock, jazz brushes, lo-fi, Latin, and analog, house and trap
  machines). Piano roll
  (draw, move, resize, copy, combine, quantize, transpose, velocity), drum step grid, on-screen
  keyboard and drum pads playable from the computer keyboard, chord creator with arpeggios, scale
  assistant, live note recording.
- **Voice to Instrument** – record or upload humming, singing or tapping. A YIN pitch tracker (and,
  optionally, Spotify's Basic Pitch model running in the browser) converts it to editable notes next
  to the original waveform; rhythm-only recordings are detected by onsets and mapped to kick, snare
  and hi-hat. Tempo and key are estimated, timing can be kept natural or quantized, pitch bends can be
  replayed, and rule-based chords, bass, drums and harmony can be added before sending it all to the
  studio.
- **AI Stem Separator** – 2, 4 or 6 stems with Demucs; synchronized waveforms with mute, solo,
  volume, pan and download per stem; send stems to the open project or a new remix project.
- **Production Studio** – multitrack timeline for audio and MIDI clips (move, trim, split, duplicate,
  merge, copy/paste, fades, clip gain), snap grid, zoom from the full five minutes down to
  milliseconds, loop region, markers, undo/redo, microphone recording with count-in, monitoring,
  input level and latency compensation, mixer with meters, eight track effects, master limiter/EQ/
  compressor, spectrum and spectrogram, loudness measurement.
- **Automation** – press **A** on a track to open a lane under it and draw volume or pan changes
  over time: click to add a point, drag to move it, double-click (or Alt-click) to remove it. Volume
  automation sits on top of the fader (0 dB = no change, the bottom of the lane is silence) and
  moves in straight lines in dB; pan automation is added to the pan knob. It plays live and is
  included in every export.
- **Pitch correction** – select an audio clip and use the Pitch correction panel in the Editor tab.
  The pitch is tracked, each moment is moved towards the nearest note of the song's key (or the
  nearest semitone) by a chosen amount and glide time, and the clip is resynthesized with TD-PSOLA so
  its timing and length stay exactly the same. A before/after pitch plot is shown, the original audio
  is kept, and "Remove correction" restores it. It is meant for one voice or instrument at a time.
- **Time-stretching** – the Speed and length panel next to it makes an audio clip faster or slower
  (50% to 200% on the slider, up to four times either way with the fit tools) without changing its
  pitch. Set the speed by hand, fit the clip to a number of bars, or have the clip's tempo detected
  and matched to the song's. It uses WSOLA (overlapping windows aligned by waveform similarity),
  always starts again from the untouched original, works together with pitch correction, and
  "Back to normal speed" undoes it. A stretched clip can still be trimmed and split.
- **Automatic crossfades** – where two audio clips on one track overlap, the earlier one fades out
  and the later one fades in across the overlap on an equal-power curve, so the level stays even
  through the join. The timeline draws the curves, playback and every export use the same ones,
  and the toolbar button switches the behaviour off. A clip's own fade handles still work as before.
- **Track groups** – from a track's menu, start a group or move the track into one. A group has its
  own row with a fader (added to each member's), mute and solo, can be folded away to a single row
  that shows an overview of its clips, moves up and down as a block, and has a strip in the mixer.
- **Video Editor** – import video clips, lay them against the song, move, trim and split them, fade
  them in and out or dissolve between overlapping clips, add titles, and preview everything in step
  with the studio transport. A clip's own soundtrack can be sent to an audio track. Exports an MP4
  (H.264 with AAC where the browser supports it) at 720p or 1080p, wide, tall or square, with the
  full studio mix as its sound; every frame is rendered exactly rather than screen-recorded.
- **Export** – WAV (16/24-bit) or MP3 of the full mix with optional loudness normalization and a
  peak ceiling, stems per track, MIDI file, and a single-file project backup (`.rnb`).
- **My Projects** – autosave, open, duplicate, delete, import/export project files, import MIDI,
  six templates (Pop, Rock, Electronic, Lo-fi, Orchestral, Cinematic).
- **Beginner / Advanced** modes – Beginner shows plain explanations and the essential controls;
  Advanced adds the compressor, gate, pitch shifter, master EQ/compressor, fade handles, finer grids,
  velocity lane, clip transposing and the recording latency offset.

### Keyboard shortcuts (Studio and Composer)

`Space` play/stop · `Enter` back to start · `R` record · `L` loop · `K` metronome · `M` marker ·
`S` split at playhead · `Delete` remove · `Ctrl/Cmd+Z` undo · `Shift+Ctrl/Cmd+Z` redo ·
`Ctrl/Cmd+C/X/V/D` copy, cut, paste, duplicate · `Ctrl/Cmd+scroll` zoom · `Ctrl/Cmd+S` save now.
In the Video Editor: `Space`, `S` to split at the playhead, `Delete` to remove the selection.
In the Composer, `A`–`;` play notes and `Z`/`X` change octave (toggle with "Computer keys").

## How it is built

- React 19, TypeScript, Vite. State in one Zustand store with snapshot undo/redo.
- `src/audio` – the engine. Tone.js provides the transport, effects and synths; samplers, drum
  synthesis, clip playback and the recorder (an AudioWorklet in `public/recorder-worklet.js`) are
  written directly on the Web Audio API. `render.ts` rebuilds the *same* graph in an
  `OfflineAudioContext`, so an export is exactly the timeline, instruments, effects and mix you hear.
- `src/audio/models.ts` – the modeled instruments: Karplus-Strong strings, additive bells and bars,
  drawbar organs rendered as seamless loops, PADsynth pads and noise-based effects.
- `src/video` – video registry and thumbnails, the frame compositor shared by preview and export,
  and the WebCodecs MP4 exporter.
- `src/lib/dsp` – pitch tracking, onset/tempo detection, the Basic Pitch wrapper, pitch correction,
  time-stretching. `src/audio/clipProcess.ts` applies the last two to a clip.
- `src/lib/mix.ts` – the group and crossfade rules, shared by playback, export and the timeline.
- `src/lib` – music theory, arrangement rules, loudness (ITU-R BS.1770), WAV/MP3/MIDI encoding,
  IndexedDB persistence, the project file format.
- Timeline and piano roll are drawn on `<canvas>`; waveforms come from the real sample data.

### Hosting

The site is published with GitHub Pages at **https://ruibinray.github.io/R-B/**. To publish a new
version, commit your changes and run:

```bash
npm run deploy
```

That builds the site and pushes `dist/` to the `gh-pages` branch, which Pages serves; the live site
updates a minute or two later. The build uses relative asset paths and hash-based routes, so
`dist/` also works on any other static host, including a sub-path.

Everything except stem separation runs in the browser, so the published site needs no server. Stem
separation still needs the Python server above. To use it from the published site, start it on your
own computer with the site's address allowed, and let the browser reach your local network if it
asks:

```bash
RNB_ALLOWED_ORIGINS="https://ruibinray.github.io" uvicorn main:app --port 8000
```

To run the server somewhere else, build with `VITE_API_URL` set to its address (or enter the address
on the AI Stem Separator page).

## Known limits

- Songs are capped at five minutes.
- Transcription and separation are estimates. Expect some wrong notes and audible artifacts and fix
  them by hand; the editors are built for that.
- Sampled instruments are 3-second General MIDI samples; sustained instruments are looped. Erhu,
  guzheng, pipa and ukulele are approximated with the closest sample in the set (labelled in the
  library). If samples cannot be downloaded, a synthesized stand-in plays instead.
- Pitch correction needs a single clear pitch: chords, full mixes and very breathy or noisy takes
  will not correct well, and large shifts change the tone of a voice. The Pitch shift track effect is
  a separate, real-time effect with the usual artifacts.
- Automation covers track volume and pan only (no effect parameters or master automation yet).
- Time-stretching keeps pitch and length exact and timing to within about 10 ms on average, but it
  is a time-domain method: drums and other sharp sounds smear or flutter at large changes, and
  anything beyond roughly 75% to 150% speed sounds processed. Tempo detection needs a steady beat.
- Automatic crossfades use an equal-power curve, which suits two different recordings. Two copies of
  the *same* recording overlapped in time with each other get about 3 dB louder in the middle.
- Groups are one level deep (no groups inside groups) and have no effects or pan of their own.
- MP4 export needs WebCodecs (current Chrome, Edge or Safari). Players that do not trim the AAC
  encoder's start-up delay play the sound about 50 ms behind the picture. Video is limited to cuts,
  fades, dissolves and titles; there are no colour tools, speed changes or picture-in-picture.
- Modeled instruments are generated the first time each one is used (well under a second) and pads
  use a few megabytes of memory each while loaded.
- There is no account sync: projects live in this browser (export a `.rnb` file to move them).
- Accompaniment suggestions are rule-based music theory, not a generative model.

## Credits and licences

- Instrument samples: **FluidR3_GM** sound set by Frank Wen, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/),
  pre-rendered by [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts). Loaded from
  jsDelivr unless self-hosted with `npm run fetch-samples`.
- [Basic Pitch](https://github.com/spotify/basic-pitch-ts) by Spotify, Apache-2.0 (model in `public/models`).
- [Demucs](https://github.com/facebookresearch/demucs) by Meta Research, MIT.
- [Tone.js](https://tonejs.github.io) (MIT), [@tonejs/midi](https://github.com/Tonejs/Midi) (MIT),
  [lamejs](https://github.com/gideonstele/lamejs) (LGPL-3.0), [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT), [Lucide](https://lucide.dev) icons (ISC),
  [Inter](https://rsms.me/inter/) typeface (OFL).
