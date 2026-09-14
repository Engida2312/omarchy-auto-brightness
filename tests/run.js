// Plain node test runner for AutoBrightnessModel.js — no framework, so it runs
// anywhere node does: `node tests/run.js`.
var M = require("../AutoBrightnessModel.js")

var passed = 0
var failures = []

function check(name, condition, detail) {
  if (condition) { passed++; return }
  failures.push(name + (detail ? "  -> " + detail : ""))
}

function eq(name, actual, expected) {
  check(name, actual === expected, "got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected))
}

function near(name, actual, expected, tolerance) {
  var ok = typeof actual === "number" && isFinite(actual) && Math.abs(actual - expected) <= tolerance
  check(name, ok, "got " + actual + ", want " + expected + " +/- " + tolerance)
}

var D = M.withDefaults(null)

// ---- clamping ----
eq("clamp below floor", M.clampPercent(-20), 1)
eq("clamp above ceiling", M.clampPercent(300), 100)
eq("clamp rounds", M.clampPercent(47.6), 48)
eq("clamp rejects NaN", M.clampPercent("banana"), 1)

// ---- smoothstep ----
eq("smoothstep low end", M.smoothstep(0, 10, -5), 0)
eq("smoothstep high end", M.smoothstep(0, 10, 50), 1)
near("smoothstep midpoint", M.smoothstep(0, 10, 5), 0.5, 1e-9)

// ---- solar elevation: Addis Ababa, 9.03N 38.74E ----
// Local noon there is ~12:25 local (EAT is UTC+3, longitude 38.74 sits west of
// the 45E zone meridian), and the sun is near the zenith in mid-September.
var noon = new Date(2026, 8, 14, 12, 25, 0)
var midnight = new Date(2026, 8, 14, 0, 30, 0)
var elevNoon = M.solarElevation(noon, 9.03, 38.74)
var elevNight = M.solarElevation(midnight, 9.03, 38.74)
check("solar noon is high", elevNoon > 70, "elevation " + elevNoon)
check("solar midnight is below horizon", elevNight < -30, "elevation " + elevNight)
eq("solar needs coordinates", M.solarElevation(noon, null, null), null)

// A polar-summer latitude keeps the sun up at local midnight; a plain
// hour-of-day schedule would get this backwards.
var tromsoMidnight = new Date(2026, 5, 21, 0, 0, 0)
check("midnight sun stays up", M.solarElevation(tromsoMidnight, 69.6, 18.9) > 0,
  "elevation " + M.solarElevation(tromsoMidnight, 69.6, 18.9))

// ---- solar curve ----
eq("solar curve floors at night", M.solarTarget(-30, D), D.nightBrightness)
eq("solar curve peaks in day", M.solarTarget(60, D), D.dayBrightness)
var dawn = M.solarTarget((D.duskElevation + D.dayElevation) / 2, D)
check("solar curve eases between", dawn > D.nightBrightness && dawn < D.dayBrightness, "got " + dawn)
eq("solar curve passes through null", M.solarTarget(null, D), null)

// ---- lux curve ----
eq("dark room -> night", M.luxTarget(0, D), D.nightBrightness)
eq("saturated -> day", M.luxTarget(100000, D), D.dayBrightness)
check("lux curve is logarithmic", M.luxTarget(100, D) > M.luxTarget(1000, D) / 2,
  "100lux=" + M.luxTarget(100, D) + " 1000lux=" + M.luxTarget(1000, D))
eq("lux rejects negative", M.luxTarget(-1, D), null)

// ---- webcam ----
eq("webcam dark -> night", M.webcamTarget(0, D), D.nightBrightness)
eq("webcam bright saturates", M.webcamTarget(1, D), D.dayBrightness)
near("webcam parses last YAVG", M.parseWebcamLuma("lavfi.signalstats.YAVG=51.0\nlavfi.signalstats.YAVG=127.5"), 0.5, 0.01)
eq("webcam parse failure is null", M.parseWebcamLuma("no readings here"), null)
eq("webcam parse empty is null", M.parseWebcamLuma(""), null)

// ---- ALS parsing ----
near("lux applies scale", M.parseLux("250", "0.25"), 62.5, 1e-9)
near("lux without scale", M.parseLux("250", ""), 250, 1e-9)
eq("lux parse failure is null", M.parseLux("", ""), null)

// ---- battery + bounds ----
eq("battery dim off by default", M.applyBatteryDim(80, true, D), 80)
eq("battery dim applies when set", M.applyBatteryDim(80, true, M.withDefaults({ batteryDim: 15 })), 65)
eq("battery dim skipped on AC", M.applyBatteryDim(80, false, M.withDefaults({ batteryDim: 15 })), 80)
eq("floor respected", M.applyFloorCeiling(1, M.withDefaults({ minBrightness: 20 })), 20)
eq("ceiling respected", M.applyFloorCeiling(99, M.withDefaults({ maxBrightness: 60 })), 60)
eq("inverted bounds are tolerated", M.applyFloorCeiling(50, M.withDefaults({ minBrightness: 80, maxBrightness: 20 })), 50)

// ---- pipeline ----
eq("pipeline solar night", M.resolveTarget({ kind: "solar", value: -30 }, false, D), D.nightBrightness)
eq("pipeline unknown source", M.resolveTarget({ kind: "mystery", value: 5 }, false, D), null)
eq("pipeline null reading", M.resolveTarget(null, false, D), null)
eq("pipeline clamps to floor",
  M.resolveTarget({ kind: "solar", value: -30 }, true, M.withDefaults({ batteryDim: 50, minBrightness: 10 })), 10)

// ---- deadband + ramp ----
eq("no adjust inside deadband", M.shouldAdjust(50, 52, D), false)
eq("adjust outside deadband", M.shouldAdjust(50, 60, D), true)
eq("no adjust on null target", M.shouldAdjust(50, null, D), false)
eq("ramp steps up", M.rampStep(50, 80, D), 52)
eq("ramp steps down", M.rampStep(50, 20, D), 48)
eq("ramp lands exactly", M.rampStep(50, 51, D), 51)
eq("ramp at target", M.rampStep(50, 50, D), 50)

// ---- manual override ----
eq("override detected", M.isManualOverride(80, 50, D), true)
eq("small drift is not override", M.isManualOverride(52, 50, D), false)
eq("no baseline means no override", M.isManualOverride(80, null, D), false)
eq("override window computed", M.overrideExpiresAt(1000, M.withDefaults({ manualOverrideMinutes: 2 })), 1000 + 120000)
eq("override disabled returns 0", M.overrideExpiresAt(1000, M.withDefaults({ manualOverrideMinutes: 0 })), 0)

// ---- defaults ----
eq("default source", D.source, "solar")
eq("bad source ignored", M.withDefaults({ source: "telepathy" }).source, "solar")
eq("valid source honoured", M.withDefaults({ source: "webcam" }).source, "webcam")
eq("junk number ignored", M.withDefaults({ dayBrightness: "bright" }).dayBrightness, 85)
eq("null ignored", M.withDefaults({ dayBrightness: null }).dayBrightness, 85)
eq("override accepted", M.withDefaults({ dayBrightness: 70 }).dayBrightness, 70)

// ---- string settings ----
eq("default monitor is empty", D.monitor, "")
eq("default webcam device", D.webcamDevice, "/dev/video0")
eq("monitor name survives merge", M.withDefaults({ monitor: "DP-1" }).monitor, "DP-1")
eq("webcam device survives merge", M.withDefaults({ webcamDevice: "/dev/video2" }).webcamDevice, "/dev/video2")
eq("empty monitor ignored", M.withDefaults({ monitor: "" }).monitor, "")

console.log("passed: " + passed + "   failed: " + failures.length)
if (failures.length) {
  failures.forEach(function(f) { console.log("  FAIL " + f) })
  process.exit(1)
}
