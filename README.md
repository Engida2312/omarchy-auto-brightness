# Auto Brightness

An Omarchy shell plugin that drives your display brightness for you. Flip it on
and it follows the light — from a real ambient light sensor if your machine has
one, and from a locally-computed sun position if it doesn't.

```
Bar:  …  󰕾   󰃠   󰍹   ⏻
             ▲
        click to toggle
```

It gets out of the way the moment you touch the brightness slider yourself.

## Install

```bash
omarchy plugin add https://github.com/Engida2312/omarchy-auto-brightness.git --enable --yes
```

That adds an **Auto Brightness** toggle to your bar. Click it to turn the
feature on; click it again to turn it off. Nothing else to configure.

To remove it:

```bash
omarchy plugin remove engida.autobrightness
```

## Light sources

`source` defaults to **`auto`**: the plugin probes your machine at startup and
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
   `allowWebcamFallback: true`** — a toggle labelled AUTO should not start using
   your camera on its own.
3. **`solar`** — sun elevation for your location, computed locally with the
   NOAA equations. No sensor, no network, no camera. The final fallback, and
   what most laptops land on.

Your coordinates come from your system timezone via tzdata's `zone.tab` — a
city-level fix with no geolocation service and no permission prompt, far finer
than a brightness curve can use. Set `latitude`/`longitude` yourself to override.

Setting `source` to `als`, `webcam` or `solar` explicitly overrides detection
and is honoured even if the hardware is missing — the sampler then reports its
own failure rather than silently substituting something else.

Detection re-runs at startup, whenever the config changes, and every ten
minutes, so a sensor that appears later is picked up without a restart.

### It tells you which one it picked

Switching it on sends a notification naming the source it detected, so you find
out whether your machine has a light sensor at the moment you turn the feature
on — not by reading docs:

> **Auto brightness on**
> Using your ambient light sensor.

> **Auto brightness on**
> No ambient light sensor on this machine - following the sun instead.

The bar toggle's tooltip says the same on hover, and `status` reports it for
scripts.

## Behaviour worth knowing

**Moving the slider wins.** If the backlight moves away from what the plugin
last set, that is you, and it stands down for `manualOverrideMinutes`
(default 30). The bar icon shows a half sun while paused. Clicking a paused
toggle resumes immediately rather than turning the feature off.

**It ramps, it doesn't jump.** Changes step `rampStep` points every
`rampIntervalMs`, so a correction reads as a transition instead of a flash.

**It ignores small gaps.** Nothing is written unless the target is more than
`threshold` points away, so the backlight isn't rewritten every minute for a
change nobody can see.

## Settings

`~/.config/omarchy/autobrightness.json` — created on first use, hot-reloads on
save. Every key is optional.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The toggle. Persisted here when you flip it. |
| `source` | `"auto"` | `auto` (detect), or force `als` / `webcam` / `solar` |
| `allowWebcamFallback` | `false` | Let `auto` use the webcam when no sensor exists |
| `latitude` / `longitude` | from timezone | Override the location used by `solar` |
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
omarchy-shell autobrightness status     # JSON: enabled, paused, source, target
omarchy-shell autobrightness enable
omarchy-shell autobrightness disable
omarchy-shell autobrightness toggle     # handy for a Hyprland keybinding
omarchy-shell autobrightness resume     # clear a manual-override pause
omarchy-shell autobrightness refresh    # sample now instead of waiting
omarchy-shell autobrightness probe      # re-run hardware detection
```

## Optional: put the switch in the Display panel

If you would rather have the switch sit next to the brightness slider in the
Display panel than in the bar, `integration/monitor-panel.patch` adds it there.

It works by forking Omarchy's built-in Display panel, which is why it is not
part of the plugin itself: the fork is personal to your machine and does not
receive Omarchy updates.

```bash
omarchy plugin clone omarchy.monitor            # creates <username>.monitor
cd ~/.config/omarchy/plugins/<username>.monitor
patch -p0 < ~/.config/omarchy/plugins/engida.autobrightness/integration/monitor-panel.patch
```

Re-apply it after an Omarchy release that changes the built-in panel. To go
back to the stock panel: `omarchy plugin remove <username>.monitor`.

## Dependencies

Everything below ships with Omarchy; nothing extra to install.

- `brightnessctl` / `omarchy-brightness-display` — applying brightness
- `ffmpeg` — only when `source` is `webcam`
- `tzdata` — the timezone → coordinates lookup used by `solar`

## Tests

The decision logic is pure and lives in `AutoBrightnessModel.js`:

```bash
node tests/run.js   # 107 assertions
```

## License

MIT — see [LICENSE](LICENSE).
