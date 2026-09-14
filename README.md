# Auto Brightness

An Omarchy shell plugin that adds an **AUTO** switch to the brightness row of
the Display panel. Turn it on and the plugin drives the backlight for you;
turn it off and brightness is yours again.

```
BRIGHTNESS                    AUTO  [ o]   85%
──────────●────────────────────────────────────
```

## How it works

Two plugins, deliberately split:

| Plugin | Kind | Job |
|---|---|---|
| `engida.autobrightness` | `service` | All the logic: sample a light source, pick a target, ramp to it |
| `engida.monitor` | `bar-widget` | A clone of the built-in Display panel with the switch added |

The panel holds no policy — it calls `toggle()` on the service and renders
what the service reports. That keeps the forked panel a thin diff against
upstream, which matters because it has to be re-applied by hand after an
Omarchy release changes the built-in panel (see *Upgrading* below).

## Light sources

Set `source` in `~/.config/omarchy/autobrightness.json`.

- **`solar`** (default) — sun elevation for your latitude/longitude, computed
  locally with the NOAA equations. No sensor, no network, no camera. This is
  the default because most laptops, including this one, have no ambient light
  sensor at all.
- **`als`** — a real ambient light sensor, read from
  `/sys/bus/iio/devices/iio:device*/in_illuminance_raw`. Mapped on a log scale,
  since perceived brightness tracks the log of luminance. Used only if you have
  the hardware; the service says so in the log if you don't.
- **`webcam`** — mean frame luminance sampled with ffmpeg. Genuine ambient
  sensing without a sensor, but it wakes the camera (and its indicator LED) on
  every sample. Opt in deliberately.

## Behaviour worth knowing

**Moving the slider wins.** If the backlight moves away from what the service
last set, that is you, and the service stands down for `manualOverrideMinutes`
(default 30). The switch label changes to `PAUSED`. Clicking a paused switch
resumes immediately rather than turning the feature off.

**It ramps, it doesn't jump.** Changes step `rampStep` points every
`rampIntervalMs` so a correction reads as a transition instead of a flash.

**It ignores small gaps.** Nothing is written unless the target is more than
`threshold` points away, so the backlight isn't rewritten every minute for a
change nobody can see.

## Settings

`~/.config/omarchy/autobrightness.json` — hot-reloads on save.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The switch. Persisted here when you flip it. |
| `source` | `"solar"` | `solar`, `als`, or `webcam` |
| `latitude` / `longitude` | from timezone | Needed by `solar` |
| `nightBrightness` | `12` | Target in the dark |
| `dayBrightness` | `85` | Target in full daylight |
| `minBrightness` / `maxBrightness` | `5` / `100` | Hard bounds, applied last |
| `duskElevation` | `-6` | Sun angle (deg) treated as night |
| `dayElevation` | `25` | Sun angle (deg) treated as full day |
| `maxLux` | `1000` | Lux that maps to `dayBrightness` (`als`) |
| `webcamGain` | `1.8` | Stretches the camera's usable range |
| `webcamDevice` | `"/dev/video0"` | Camera to sample |
| `batteryDim` | `0` | Points to subtract on battery. `0` disables. |
| `threshold` | `3` | Deadband before writing |
| `rampStep` / `rampIntervalMs` | `2` / `180` | Ramp speed |
| `intervalSeconds` | `60` | Sampling period |
| `manualOverrideMinutes` | `30` | Pause length after a manual change |
| `overrideThreshold` | `4` | Drift that counts as manual |
| `monitor` | `""` | Target a specific display; empty means focused |

## CLI

```bash
omarchy-shell autobrightness status     # JSON: enabled, paused, target, source
omarchy-shell autobrightness enable
omarchy-shell autobrightness disable
omarchy-shell autobrightness toggle     # handy for a Hyprland keybinding
omarchy-shell autobrightness resume     # clear a manual-override pause
omarchy-shell autobrightness refresh    # sample now instead of waiting
```

## Tests

The decision logic is pure and lives in `AutoBrightnessModel.js`:

```bash
node tests/run.js
```

## Upgrading

`engida.monitor` is a fork of the built-in Display panel, so an Omarchy update
that changes `omarchy.monitor` will not reach it. To re-fork:

```bash
omarchy plugin remove engida.monitor      # back to the built-in
omarchy plugin clone omarchy.monitor      # fresh copy of the new upstream
patch -p0 < integration/monitor-panel.patch   # may need fuzz; it is ~50 lines
```

The patch touches exactly two places: a block of properties near the top of
`Panel.qml`, and the brightness section header where the switch is added.

## Uninstalling

```bash
omarchy plugin disable engida.autobrightness
omarchy plugin remove engida.monitor      # restores the stock Display panel
```
