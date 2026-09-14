// Pure logic for the auto-brightness service. No QML, no I/O — every function
// here takes plain values and returns plain values so the same code can be
// exercised by tests/run.js under node.

var MIN_PERCENT = 1
var MAX_PERCENT = 100

function clampPercent(value) {
  var n = Number(value)
  if (!isFinite(n)) return MIN_PERCENT
  return Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, Math.round(n)))
}

// Number("") and Number(null) are 0, and Number(undefined) is NaN, so an
// isFinite() check alone cannot tell "absent" from "zero". Every place that
// reads a possibly-missing value goes through here first.
function isNumeric(value) {
  if (value === null || value === undefined) return false
  if (typeof value === "string" && value.trim() === "") return false
  return isFinite(Number(value))
}

function clamp(value, low, high) {
  var n = Number(value)
  if (!isFinite(n)) return low
  return Math.max(low, Math.min(high, n))
}

// Hermite smoothstep. Used instead of a straight lerp so brightness eases in
// and out of the endpoints rather than hitting them with a visible corner.
function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1
  var t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------- solar

function dayOfYear(date) {
  var start = new Date(date.getFullYear(), 0, 0)
  return Math.floor((date - start) / 86400000)
}

// Solar elevation in degrees via the NOAA low-precision equations. Good to
// well under a degree, which is far finer than a brightness curve needs, and
// it costs no network call or extra package — the alternative (geoclue plus a
// sunrise table) is a dependency for precision nobody can see on a backlight.
function solarElevation(date, latitude, longitude) {
  // Guard before Number(): Number(null) and Number("") are both 0, which is
  // finite, so an unset latitude would otherwise be read as the equator and
  // return a confident, wrong elevation.
  if (!isNumeric(latitude) || !isNumeric(longitude)) return null
  var lat = Number(latitude)
  var lon = Number(longitude)

  var rad = Math.PI / 180
  var doy = dayOfYear(date)
  var hours = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600

  // getTimezoneOffset is minutes *behind* UTC, so negate it to get the offset.
  var tzHours = -date.getTimezoneOffset() / 60

  var gamma = (2 * Math.PI / 365) * (doy - 1 + (hours - 12) / 24)

  var eqTime = 229.18 * (0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma))

  var decl = 0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma)

  var timeOffset = eqTime + 4 * lon - 60 * tzHours
  var trueSolarTime = hours * 60 + timeOffset
  var hourAngle = (trueSolarTime / 4) - 180

  var cosZenith = Math.sin(lat * rad) * Math.sin(decl)
    + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(hourAngle * rad)

  return 90 - (Math.acos(clamp(cosZenith, -1, 1)) / rad)
}

// Sun elevation -> screen brightness. Below `duskElevation` the sun is down or
// nearly so and the room is lit artificially; above `dayElevation` it is
// properly daylight. Between them the curve eases, which is exactly the window
// where a hard step would be most noticeable.
function solarTarget(elevation, settings) {
  if (elevation === null || elevation === undefined) return null
  var night = clampPercent(settings.nightBrightness)
  var day = clampPercent(settings.dayBrightness)
  var dusk = Number(settings.duskElevation)
  var noon = Number(settings.dayElevation)
  if (!isFinite(dusk)) dusk = -6
  if (!isFinite(noon)) noon = 25
  return clampPercent(night + (day - night) * smoothstep(dusk, noon, elevation))
}

// ------------------------------------------------------------ ambient

// Ambient illuminance (lux) -> brightness, on a log scale. Perceived
// brightness tracks the logarithm of luminance, so a linear map would spend
// most of its range on the top two stops and leave indoor light indistinct.
function luxTarget(lux, settings) {
  var value = Number(lux)
  if (!isFinite(value) || value < 0) return null
  var night = clampPercent(settings.nightBrightness)
  var day = clampPercent(settings.dayBrightness)
  var maxLux = Number(settings.maxLux)
  if (!isFinite(maxLux) || maxLux <= 1) maxLux = 1000

  var t = Math.log10(1 + value) / Math.log10(1 + maxLux)
  return clampPercent(night + (day - night) * clamp(t, 0, 1))
}

// Mean frame luminance from the webcam, 0..1 -> brightness. `webcamGain`
// stretches the usable part of the range: a laptop camera indoors rarely
// reports above ~0.6 even in a bright room.
function webcamTarget(luma, settings) {
  var value = Number(luma)
  if (!isFinite(value) || value < 0) return null
  var night = clampPercent(settings.nightBrightness)
  var day = clampPercent(settings.dayBrightness)
  var gain = Number(settings.webcamGain)
  if (!isFinite(gain) || gain <= 0) gain = 1.8

  return clampPercent(night + (day - night) * clamp(value * gain, 0, 1))
}

// ffmpeg's signalstats filter prints `lavfi.signalstats.YAVG=<0..255>` per
// frame. Take the last reading and normalise; anything unparseable is a
// failed sample, not a dark room, so return null rather than 0.
function parseWebcamLuma(text) {
  var matches = String(text || "").match(/YAVG=([0-9.]+)/g)
  if (!matches || matches.length === 0) return null
  var last = matches[matches.length - 1].split("=")[1]
  var value = Number(last)
  if (!isFinite(value)) return null
  return clamp(value / 255, 0, 1)
}

// Kernel ALS nodes report raw counts or lux depending on the driver; `scale`
// converts. Missing scale means the raw value is already lux.
function parseLux(rawText, scaleText) {
  var rawTrimmed = String(rawText === null || rawText === undefined ? "" : rawText).trim()
  if (!isNumeric(rawTrimmed)) return null
  var raw = Number(rawTrimmed)
  if (raw < 0) return null

  var scaleTrimmed = String(scaleText === null || scaleText === undefined ? "" : scaleText).trim()
  var scale = isNumeric(scaleTrimmed) ? Number(scaleTrimmed) : 1
  if (!(scale > 0)) scale = 1
  return raw * scale
}

// ------------------------------------------------------------ source

var SOURCES = ["auto", "als", "webcam", "solar"]

// Which source to actually sample, given what the machine turned out to have.
//
// `capabilities` is what the hardware probe found: { als: bool, webcam: bool }.
// A null capabilities means the probe has not answered yet -- say so rather
// than guessing, so the caller can wait instead of sampling the wrong thing.
//
// Order is by quality of evidence. A real ambient light sensor measures the
// light actually falling on the machine; the webcam infers it from a picture of
// whatever the lid happens to face; the solar curve is an estimate from the
// clock that knows nothing about the room. Prefer the sensor whenever one
// exists.
function detectSource(settings, capabilities) {
  var configured = String((settings && settings.source) || "auto")

  // An explicit choice is honoured even if the hardware is missing: the user
  // asked for it, and the sampler reports its own failure clearly.
  if (configured !== "auto") return configured
  if (!capabilities) return null

  if (capabilities.als === true) return "als"
  if (capabilities.webcam === true && settings && settings.allowWebcamFallback === true) return "webcam"
  return "solar"
}

// Why the effective source was chosen, for the status line and the tooltip.
function sourceReason(settings, capabilities, effective) {
  var configured = String((settings && settings.source) || "auto")
  if (configured !== "auto") return "set to " + configured
  if (!capabilities) return "detecting hardware"
  if (effective === "als") return "ambient light sensor detected"
  if (effective === "webcam") return "no light sensor; using the webcam"
  if (capabilities.webcam === true) return "no light sensor; estimating from the sun"
  return "no light sensor or webcam; estimating from the sun"
}

// Parse the hardware probe's output ("als=1 cam=0").
function parseCapabilities(text) {
  var raw = String(text === null || text === undefined ? "" : text).trim()
  if (raw === "") return null
  var als = /\bals=1\b/.test(raw)
  var webcam = /\bcam=1\b/.test(raw)
  if (!/\bals=[01]\b/.test(raw) || !/\bcam=[01]\b/.test(raw)) return null
  return { als: als, webcam: webcam }
}

// What to tell the user the moment they switch AUTO on. Whether this machine
// has a light sensor is the single most useful thing to say here: it decides
// how the feature behaves, the user cannot see it anywhere else without
// digging, and on a laptop without one the honest answer ("following the sun")
// sets expectations that a silent fallback would quietly break.
function announcement(settings, capabilities, effective) {
  var configured = String((settings && settings.source) || "auto")
  var headline = "Auto brightness on"
  var detected = configured === "auto"

  if (effective === "als") {
    return { headline: headline, body: "Using your ambient light sensor." }
  }

  if (effective === "webcam") {
    return {
      headline: headline,
      body: detected
        ? "No ambient light sensor found - sensing light with your webcam."
        : "Sensing light with your webcam."
    }
  }

  if (effective === "solar") {
    return {
      headline: headline,
      body: detected
        ? "No ambient light sensor on this machine - following the sun instead."
        : "Following the sun."
    }
  }

  // Detection has not answered yet; the caller waits rather than sending this.
  return null
}

// ------------------------------------------------------------ shaping

// On battery, pull the target down by `batteryDim` points. Returns the target
// unchanged when the modifier is off or the machine is plugged in.
function applyBatteryDim(target, onBattery, settings) {
  if (target === null || target === undefined) return target
  var dim = Number(settings.batteryDim)
  if (!isFinite(dim) || dim <= 0 || !onBattery) return clampPercent(target)
  return clampPercent(target - dim)
}

function applyFloorCeiling(target, settings) {
  if (target === null || target === undefined) return target
  var floor = clampPercent(settings.minBrightness)
  var ceiling = clampPercent(settings.maxBrightness)
  if (floor > ceiling) {
    var swap = floor
    floor = ceiling
    ceiling = swap
  }
  return clampPercent(Math.max(floor, Math.min(ceiling, Math.round(target))))
}

// Full pipeline from a raw reading to the brightness we want on screen.
function resolveTarget(reading, onBattery, settings) {
  var target = null
  if (!reading) return null

  if (reading.kind === "lux") target = luxTarget(reading.value, settings)
  else if (reading.kind === "webcam") target = webcamTarget(reading.value, settings)
  else if (reading.kind === "solar") target = solarTarget(reading.value, settings)

  if (target === null) return null
  return applyFloorCeiling(applyBatteryDim(target, onBattery, settings), settings)
}

// Deadband. Backlights quantise, and a one-point correction is invisible while
// still costing a write and an ALS/webcam wakeup — so only move when the gap is
// worth the trip.
function shouldAdjust(current, target, settings) {
  if (target === null || target === undefined) return false
  var threshold = Number(settings.threshold)
  if (!isFinite(threshold) || threshold < 0) threshold = 3
  return Math.abs(Number(current) - Number(target)) > threshold
}

// One step of the ramp toward `target`. Stepping rather than jumping keeps the
// change below the threshold where the eye reads it as a transition instead of
// a flash.
function rampStep(current, target, settings) {
  var from = clampPercent(current)
  var to = clampPercent(target)
  var step = Number(settings.rampStep)
  if (!isFinite(step) || step <= 0) step = 2

  if (from === to) return to
  var delta = to - from
  if (Math.abs(delta) <= step) return to
  return clampPercent(from + (delta > 0 ? step : -step))
}

// The user moving the slider while auto is on is a correction, not a fight to
// win: treat an unexplained jump away from what we last wrote as a manual
// override and stand down for a while. `lastApplied` is what the service set;
// anything beyond `threshold` from it came from somewhere else.
function isManualOverride(observed, lastApplied, settings) {
  if (lastApplied === null || lastApplied === undefined) return false
  var threshold = Number(settings.overrideThreshold)
  if (!isFinite(threshold) || threshold < 0) threshold = 4
  return Math.abs(Number(observed) - Number(lastApplied)) > threshold
}

function overrideExpiresAt(nowMs, settings) {
  var minutes = Number(settings.manualOverrideMinutes)
  if (!isFinite(minutes) || minutes <= 0) return 0
  return Number(nowMs) + minutes * 60000
}

// Merge user settings over the shipped defaults. Anything absent, null, or
// unparseable falls back rather than poisoning the curve with NaN.
function withDefaults(settings) {
  var defaults = {
    source: "auto",
    latitude: null,
    longitude: null,
    nightBrightness: 12,
    dayBrightness: 85,
    minBrightness: 5,
    maxBrightness: 100,
    duskElevation: -6,
    dayElevation: 25,
    maxLux: 1000,
    webcamGain: 1.8,
    batteryDim: 0,
    threshold: 3,
    rampStep: 2,
    rampIntervalMs: 180,
    intervalSeconds: 60,
    manualOverrideMinutes: 30,
    overrideThreshold: 4,
    monitor: "",
    webcamDevice: "/dev/video0",
    // Where kernel IIO devices live. Overridable so the sensor path can be
    // pointed at a fixture and exercised on a machine with no sensor -- and so
    // an unusual kernel layout is a config change, not a code change.
    alsPath: "/sys/bus/iio/devices",
    // The webcam is deliberately outside the automatic cascade. It is the only
    // source that costs the user something to sample -- the camera wakes, and
    // on most laptops its indicator LED lights -- and a switch labelled AUTO
    // should not decide that on their behalf. Opt in and it joins the cascade
    // ahead of the solar estimate.
    allowWebcamFallback: false
  }

  var merged = {}
  for (var key in defaults) merged[key] = defaults[key]
  if (!settings) return merged

  for (var given in defaults) {
    if (!(given in settings)) continue
    var value = settings[given]
    if (value === null || value === undefined || value === "") continue
    if (given === "source") {
      var source = String(value)
      if (SOURCES.indexOf(source) !== -1) merged.source = source
      continue
    }
    if (typeof defaults[given] === "boolean") {
      merged[given] = value === true || value === "true"
      continue
    }
    // `monitor` and `webcamDevice` are names, not quantities — Number() would
    // turn "DP-1" into NaN and silently discard the user's setting.
    if (typeof defaults[given] === "string") {
      merged[given] = String(value)
      continue
    }
    var numeric = Number(value)
    if (isFinite(numeric)) merged[given] = numeric
  }

  return merged
}

if (typeof module !== "undefined") {
  module.exports = {
    isNumeric: isNumeric,
    clampPercent: clampPercent,
    smoothstep: smoothstep,
    solarElevation: solarElevation,
    solarTarget: solarTarget,
    luxTarget: luxTarget,
    webcamTarget: webcamTarget,
    parseWebcamLuma: parseWebcamLuma,
    parseLux: parseLux,
    applyBatteryDim: applyBatteryDim,
    applyFloorCeiling: applyFloorCeiling,
    resolveTarget: resolveTarget,
    shouldAdjust: shouldAdjust,
    rampStep: rampStep,
    isManualOverride: isManualOverride,
    overrideExpiresAt: overrideExpiresAt,
    withDefaults: withDefaults,
    detectSource: detectSource,
    sourceReason: sourceReason,
    parseCapabilities: parseCapabilities,
    announcement: announcement,
    SOURCES: SOURCES
  }
}
