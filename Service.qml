import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.UPower
import "AutoBrightnessModel.js" as Model

// Headless singleton that owns automatic brightness.
//
// The shell loads exactly one of these (see shell.qml `ensureService`), so this
// is the single writer for auto-driven brightness changes. UI — the AUTO switch
// on the Display panel — reaches it with `shell.serviceFor("engida.autobrightness")`
// and only ever calls `toggle()`/`setEnabled()`; all policy lives here.
//
// Every decision function is in AutoBrightnessModel.js and covered by
// tests/run.js. This file is the I/O shell around it: sample a light source,
// ask the model for a target, ramp to it.
Item {
  id: root

  // Injected by the shell's service loader.
  property var shell: null
  property var manifest: null

  readonly property string configPath: Quickshell.env("HOME") + "/.config/omarchy/autobrightness.json"

  property var settings: Model.withDefaults(null)
  // Not named `enabled`: QQuickItem already has one, and shadowing it makes
  // `service.enabled` ambiguous for anything holding this as a var. The JSON
  // config key and the IPC surface still say `enabled`.
  property bool autoEnabled: false
  property bool configLoaded: false

  // Last brightness this service wrote. Anything that moves the backlight away
  // from it came from somewhere else — the slider, a keybinding — and is
  // treated as the user taking over.
  property var lastApplied: null
  property int currentBrightness: -1
  property var target: null
  property real overrideUntilMs: 0
  property bool sampling: false

  // A reading is { kind: "solar"|"lux"|"webcam", value: Number }.
  property var lastReading: null

  // What the machine actually has: { als: bool, webcam: bool }, or null until
  // the probe has answered. Null is meaningfully different from "nothing
  // found" -- with `source: "auto"` we wait for the answer rather than
  // sampling the wrong thing on the first tick.
  property var capabilities: null
  property bool sampleAfterProbe: false
  property bool probeQueued: false
  // Set when AUTO is switched on, cleared once we have actually told the user
  // which light source they got. Detection may still be in flight at that
  // moment, and announcing "following the sun" a beat before the sensor is
  // found would be worse than staying quiet for one probe.
  property bool announceOnResolve: false

  readonly property bool onBattery: {
    try { return UPower.onBattery === true } catch (e) { return false }
  }

  // Paused means "on, but standing down because the user just adjusted it".
  readonly property bool paused: overrideUntilMs > 0 && Date.now() < overrideUntilMs
  readonly property bool active: autoEnabled && !paused

  // What the user asked for ("auto" by default) ...
  readonly property string source: String(settings.source || "auto")
  // ... and what that resolves to against this machine's hardware. Null while
  // the probe is still running.
  readonly property var effectiveSource: Model.detectSource(root.settings, root.capabilities)
  readonly property string sourceReason: Model.sourceReason(root.settings, root.capabilities, root.effectiveSource)

  readonly property string statusText: {
    if (!autoEnabled) return "Off"
    if (paused) return "Paused (manual)"
    if (!effectiveSource) return "Detecting light source"
    if (target === null) return "Waiting for a reading"
    return "Following " + effectiveSource + " -> " + target + "%"
  }

  signal changed()

  // --------------------------------------------------------------- config

  function applyConfig(text) {
    var parsed = null
    try {
      parsed = text && String(text).trim() !== "" ? JSON.parse(String(text)) : {}
    } catch (e) {
      console.warn("autobrightness: config is not valid JSON, using defaults:", e)
      parsed = {}
    }
    if (!parsed || typeof parsed !== "object") parsed = {}

    root.settings = Model.withDefaults(parsed)
    root.autoEnabled = parsed.enabled === true
    root.configLoaded = true
    root.changed()

    sampleTimer.interval = Math.max(5, Number(root.settings.intervalSeconds)) * 1000
    rampTimer.interval = Math.max(50, Number(root.settings.rampIntervalMs))

    // Settings can move the goalposts for detection (alsPath especially), so
    // the cached probe result is no longer trustworthy. Re-ask.
    probeCapabilities()

    if (root.autoEnabled) tick()
    else rampTimer.stop()
  }

  // Persist the whole config back. The file is the user's to edit, so read it,
  // change only what we own, and write it back rather than serialising our
  // in-memory view and dropping keys we did not recognise.
  function persist() {
    var existing = {}
    try {
      var raw = configFile.text()
      if (raw && String(raw).trim() !== "") existing = JSON.parse(String(raw))
    } catch (e) {
      existing = {}
    }
    if (!existing || typeof existing !== "object") existing = {}

    existing.enabled = root.autoEnabled
    configFile.setText(JSON.stringify(existing, null, 2) + "\n")
  }

  // ---------------------------------------------------------------- control

  function setEnabled(value) {
    var next = value === true
    if (next === root.autoEnabled) return

    root.autoEnabled = next
    root.overrideUntilMs = 0
    root.lastApplied = null
    persist()
    root.changed()

    if (next) {
      root.announceOnResolve = true
      tick()
      maybeAnnounce()   // fires now if detection already has an answer
    } else {
      root.announceOnResolve = false
      rampTimer.stop()
    }
  }

  // Tell the user what the switch actually did, once we know. Reaches for the
  // desktop notification rather than the OSD: the OSD is a transient bar built
  // for a value changing, and this is a sentence worth reading.
  function maybeAnnounce() {
    if (!root.announceOnResolve) return
    if (!root.autoEnabled) {
      root.announceOnResolve = false
      return
    }
    if (!root.effectiveSource) return   // probe still running; try again after

    var message = Model.announcement(root.settings, root.capabilities, root.effectiveSource)
    if (!message) return

    root.announceOnResolve = false
    if (announceProcess.running) return
    announceProcess.command = [
      "omarchy-notification-send",
      "-g", "󰃠",   // brightness glyph, matching the shell's own icon style
      message.headline,
      message.body
    ]
    announceProcess.running = true
  }

  function toggle() {
    setEnabled(!root.autoEnabled)
  }

  // Clear a manual-override pause and start following again immediately.
  function resume() {
    root.overrideUntilMs = 0
    root.lastApplied = null
    root.changed()
    if (root.autoEnabled) tick()
  }

  // ---------------------------------------------------------------- sampling

  function tick() {
    if (!root.autoEnabled || root.sampling) return
    root.sampling = true
    readProcess.running = true   // current brightness first; sources follow
  }

  function onBrightnessRead(text) {
    var value = parseInt(String(text).trim(), 10)
    root.currentBrightness = isFinite(value) ? value : -1

    // The user moved the slider since our last write: stand down for a while
    // rather than yanking it back on the next tick.
    if (root.currentBrightness >= 0
        && Model.isManualOverride(root.currentBrightness, root.lastApplied, root.settings)) {
      root.overrideUntilMs = Model.overrideExpiresAt(Date.now(), root.settings)
      root.lastApplied = null
      root.sampling = false
      rampTimer.stop()
      root.changed()
      return
    }

    if (root.paused) {
      root.sampling = false
      root.changed()
      return
    }

    sampleSource()
  }

  function sampleSource() {
    // `auto` with no probe result yet: find out what this machine has, then
    // come back here. The probe is a single cheap bash call.
    if (!root.effectiveSource) {
      root.sampleAfterProbe = true
      probeCapabilities()
      return
    }

    if (root.effectiveSource === "als") {
      alsProcess.running = true
      return
    }
    if (root.effectiveSource === "webcam") {
      webcamProcess.command = webcamCommand()
      webcamProcess.running = true
      return
    }
    // Solar needs no subprocess — it is arithmetic on the clock.
    var elevation = Model.solarElevation(new Date(), root.settings.latitude, root.settings.longitude)
    if (elevation === null) {
      console.warn("autobrightness: solar source needs latitude and longitude in " + root.configPath)
      finishSample(null)
      return
    }
    finishSample({ kind: "solar", value: elevation })
  }

  // Shell-quote for embedding in the bash -c probes below.
  function alsRoot() {
    var raw = String(root.settings.alsPath || "/sys/bus/iio/devices")
    return "'" + raw.replace(/'/g, "'\\''") + "'"
  }

  function probeCapabilities() {
    // A probe already running was launched with the *previous* settings, so a
    // request arriving now is not redundant -- the startup probe races the
    // config load, and dropping the second one pins `alsPath` to its default.
    if (capabilityProbe.running) {
      root.probeQueued = true
      return
    }
    capabilityProbe.command = root.capabilityProbeCommand()
    capabilityProbe.running = true
  }

  function capabilityProbeCommand() {
    return ["bash", "-c",
      'als=0; for d in ' + root.alsRoot() + '/iio:device*; do ' +
      '[ -r "$d/in_illuminance_raw" ] && { als=1; break; }; done; ' +
      'cam=0; command -v ffmpeg >/dev/null 2>&1 && ' +
      'for v in /dev/video*; do [ -e "$v" ] && { cam=1; break; }; done; ' +
      'printf "als=%s cam=%s\\n" "$als" "$cam"']
  }

  function webcamCommand() {
    var device = String(root.settings.webcamDevice || "/dev/video0")
    // Grab a few frames and use the last: the first frames off a UVC camera
    // arrive before auto-exposure settles and read far too dark.
    return ["ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "v4l2", "-i", device,
            "-frames:v", "5",
            "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
            "-an", "-f", "null", "-"]
  }

  function finishSample(reading) {
    root.sampling = false
    root.lastReading = reading

    var next = Model.resolveTarget(reading, root.onBattery, root.settings)
    root.target = next
    root.changed()

    if (next === null) return
    if (root.currentBrightness < 0) return
    if (!Model.shouldAdjust(root.currentBrightness, next, root.settings)) return

    rampTimer.restart()
  }

  // ---------------------------------------------------------------- applying

  function rampTick() {
    if (!root.active || root.target === null || root.currentBrightness < 0) {
      rampTimer.stop()
      return
    }

    var next = Model.rampStep(root.currentBrightness, root.target, root.settings)
    if (next === root.currentBrightness) {
      rampTimer.stop()
      return
    }

    root.currentBrightness = next
    root.lastApplied = next
    apply(next)

    if (next === Model.clampPercent(root.target)) rampTimer.stop()
  }

  function apply(percent) {
    if (applyProcess.running) return   // next ramp tick retries
    applyProcess.command = brightnessCommand(percent)
    applyProcess.running = true
  }

  function brightnessCommand(percent) {
    var command = ["omarchy-brightness-display", "--no-osd"]
    var monitor = String(root.settings.monitor || "")
    if (monitor !== "") {
      command.push("--monitor")
      command.push(monitor)
    }
    command.push(String(Model.clampPercent(percent)) + "%")
    return command
  }

  function readCommand() {
    var command = ["omarchy-brightness-display"]
    var monitor = String(root.settings.monitor || "")
    if (monitor !== "") {
      command.push("--monitor")
      command.push(monitor)
    }
    return command
  }

  // ------------------------------------------------------------------ wiring

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.applyConfig(text())
    onLoadFailed: root.applyConfig("")   // no config yet: defaults, off
    onFileChanged: reload()
  }

  Process {
    id: readProcess
    command: root.readCommand()
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.onBrightnessRead(text)
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.currentBrightness = -1
        root.sampling = false
      }
    }
  }

  Process {
    id: applyProcess
  }

  Process {
    id: announceProcess
  }

  // Hardware probe. Re-run periodically as well as at startup: a USB ambient
  // light sensor or camera can appear after the shell is up, and the answer
  // decides which source `auto` picks.
  Process {
    id: capabilityProbe
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var found = Model.parseCapabilities(text)
        var before = root.effectiveSource
        if (found) root.capabilities = found
        root.changed()
        // Detection changed the answer (a sensor appeared, say): act on it now
        // instead of running the old source until the next interval.
        if (root.autoEnabled && root.effectiveSource !== before) root.tick()
        // Detection just answered; this is the moment the announcement has
        // something true to say.
        root.maybeAnnounce()
      }
    }
    onExited: function(exitCode) {
      // An unparseable or failed probe leaves `capabilities` as it was. On a
      // cold start that is still null, so treat it as "nothing found" rather
      // than retrying forever and never sampling.
      if (root.capabilities === null) root.capabilities = { als: false, webcam: false }
      if (root.probeQueued) {
        root.probeQueued = false
        root.probeCapabilities()
        return
      }
      if (root.sampleAfterProbe) {
        root.sampleAfterProbe = false
        root.sampleSource()
      }
    }
  }

  Process {
    id: alsProcess
    // Kernel ALS nodes live at unpredictable indices; take the first that has
    // a raw illuminance and print it with its scale for parseLux.
    command: ["bash", "-c",
      'for d in ' + root.alsRoot() + '/iio:device*; do ' +
      '[ -r "$d/in_illuminance_raw" ] || continue; ' +
      'printf "%s %s\\n" "$(cat "$d/in_illuminance_raw")" "$(cat "$d/in_illuminance_scale" 2>/dev/null)"; ' +
      'exit 0; done; exit 1']
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parts = String(text).trim().split(/\s+/)
        var lux = Model.parseLux(parts[0], parts.length > 1 ? parts[1] : "")
        root.finishSample(lux === null ? null : { kind: "lux", value: lux })
      }
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        console.warn("autobrightness: no ambient light sensor found; set \"source\" to \"solar\" or \"webcam\" in " + root.configPath)
        root.finishSample(null)
      }
    }
  }

  Process {
    id: webcamProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var luma = Model.parseWebcamLuma(text)
        root.finishSample(luma === null ? null : { kind: "webcam", value: luma })
      }
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        console.warn("autobrightness: webcam sample failed (device busy or missing)")
        root.finishSample(null)
      }
    }
  }

  Component.onCompleted: root.probeCapabilities()

  // Slow re-probe: hardware changes are rare, so this is about eventually
  // noticing a plugged-in sensor, not about reacting quickly.
  Timer {
    interval: 600000
    running: true
    repeat: true
    onTriggered: root.probeCapabilities()
  }

  Timer {
    id: sampleTimer
    interval: 60000
    running: root.autoEnabled
    repeat: true
    triggeredOnStart: true
    onTriggered: root.tick()
  }

  Timer {
    id: rampTimer
    interval: 180
    repeat: true
    onTriggered: root.rampTick()
  }

  // A pause expires on the clock, so nothing else would wake the UI to show it
  // has resumed. Poll cheaply while one is in flight.
  Timer {
    interval: 5000
    running: root.autoEnabled && root.overrideUntilMs > 0
    repeat: true
    onTriggered: {
      if (Date.now() >= root.overrideUntilMs) {
        root.overrideUntilMs = 0
        root.lastApplied = null
        root.changed()
        root.tick()
      }
    }
  }

  // Re-evaluate as soon as the power source changes rather than waiting out the
  // sample interval — the battery modifier should feel immediate.
  Connections {
    target: UPower
    function onOnBatteryChanged() { if (root.autoEnabled) root.tick() }
  }

  IpcHandler {
    target: "autobrightness"

    function status(): string {
      return JSON.stringify({
        enabled: root.autoEnabled,
        paused: root.paused,
        active: root.active,
        source: root.source,
        effectiveSource: root.effectiveSource,
        sourceReason: root.sourceReason,
        capabilities: root.capabilities,
        target: root.target,
        current: root.currentBrightness,
        onBattery: root.onBattery,
        status: root.statusText
      })
    }

    function enable(): string {
      root.setEnabled(true)
      return "enabled"
    }

    function disable(): string {
      root.setEnabled(false)
      return "disabled"
    }

    function toggle(): string {
      root.toggle()
      return root.autoEnabled ? "enabled" : "disabled"
    }

    function resume(): string {
      root.resume()
      return "resumed"
    }

    function refresh(): void {
      root.tick()
    }

    // Re-run hardware detection now, rather than waiting for the slow timer.
    function probe(): string {
      root.probeCapabilities()
      return "probing"
    }
  }
}
