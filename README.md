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

`source` defaults to **`auto`**: the plugin probes the machine at startup and
picks the best source available, preferring a real sensor. You do not configure
anything for this to work.

The cascade, best evidence first:

1. **`als`** — a real ambient light sensor
   (`/sys/bus/iio/devices/iio:device*/in_illuminance_raw`). Measures the light
   actually falling on the machine, so it is always preferred when present.
   Mapped on a log scale, since perceived brightness tracks the log of
   luminance.
2. **`webcam`** — mean frame luminance, sampled with ffmpeg. Real ambient
   sensing without a sensor, but it wakes the camera and on most laptops lights
   its indicator LED. **Not in the cascade unless you set
   `allowWebcamFallback: true`** — a switch labelled AUTO should not start using
   your camera on its own.
3. **`solar`** — sun elevation for your latitude/longitude, computed locally
   with the NOAA equations. No sensor, no network, no camera. The final
   fallback, and what most laptops (including this one) land on.

Setting `source` to `als`, `webcam` or `solar` explicitly overrides detection
and is honoured even if the hardware is missing — the sampler then reports its
own failure rather than silently substituting something else.

Detection re-runs at startup, whenever the config file changes, and every ten
minutes, so a sensor that appears later is picked up without a restart. Force it
with `omarchy-shell autobrightness probe`.

To see what it chose:

```console
$ omarchy-shell autobrightness status | jq -c '{effectiveSource, sourceReason}'
{"effectiveSource":"solar","sourceReason":"no light sensor; estimating from the sun"}
```

The switch's tooltip says the same thing, so the automatic choice is visible
without leaving the panel.

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
| `source` | `"auto"` | `auto` (detect), or force `als` / `webcam` / `solar` |
| `allowWebcamFallback` | `false` | Let `auto` use the webcam when no sensor exists |
| `latitude` / `longitude` | from timezone | Needed by `solar` |
| `nightBrightness` | `12` | Target in the dark |
| `dayBrightness` | `85` | Target in full daylight |
| `minBrightness` / `maxBrightness` | `5` / `100` | Hard bounds, applied last |
| `duskElevation` | `-6` | Sun angle (deg) treated as night |
| `dayElevation` | `25` | Sun angle (deg) treated as full day |
| `maxLux` | `1000` | Lux that maps to `dayBrightness` (`als`) |
| `webcamGain` | `1.8` | Stretches the camera's usable range |
| `webcamDevice` | `"/dev/video0"` | Camera to sample |
| `alsPath` | `"/sys/bus/iio/devices"` | Where to look for IIO sensors |
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
omarchy-shell autobrightness probe      # re-run hardware detection
```

## Tests

The decision logic is pure and lives in `AutoBrightnessModel.js`:

```bash
node tests/run.js   # 85 assertions
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
