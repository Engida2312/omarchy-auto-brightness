import QtQuick
import qs.Ui
import qs.Commons

// Bar toggle for auto brightness.
//
// Self-contained on purpose: the in-panel switch needs a fork of Omarchy's
// Display panel, which cannot ship as a plugin, so this is the control every
// installed copy gets. It holds no policy -- the engida.autobrightness service
// decides everything; this reads its state and calls toggle().
BarIconButton {
  id: root
  // Declared, not assigned: BarIconButton inherits WidgetButton, which has no
  // moduleName of its own, and the bar sets this via injectProps() only when
  // the property already exists on the widget.
  property string moduleName: "engida.autobrightness"
  property var settings: ({})

  // Resolved imperatively rather than as a binding on `bar.shell`. The bar is
  // assigned to plugin widgets after construction (Bar.qml's injectProps runs
  // on Qt.callLater), so a declarative chain through `bar` evaluates once
  // against null and never recovers.
  property var service: null

  function resolveService() {
    var barRef = root.bar
    var shellRef = barRef ? barRef.shell : null
    root.service = (shellRef && typeof shellRef.serviceFor === "function")
      ? shellRef.serviceFor("engida.autobrightness")
      : null
  }

  onBarChanged: root.resolveService()
  Component.onCompleted: root.resolveService()

  readonly property bool on: service ? service.autoEnabled === true : false
  readonly property bool paused: service ? service.paused === true : false
  readonly property string sourceName: service && service.effectiveSource
    ? String(service.effectiveSource)
    : ""
  readonly property string reason: service ? String(service.sourceReason || "") : ""

  // Brightness glyphs at three levels, so the state reads at a glance in a bar
  // where everything is the same colour: full sun following, half sun paused,
  // low sun off.
  text: !on ? "󰃞" : (paused ? "󰃟" : "󰃠")

  active: on && !paused
  activeColor: Color.accent
  // Off is a resting state, not an error -- dim it rather than colour it.
  dimmed: !on

  tooltipText: {
    if (!service) return "Auto brightness (service not running)"
    if (!on) return reason !== "" ? "Auto brightness off - " + reason : "Auto brightness off"
    if (paused) return "Auto brightness paused after a manual change - click to resume"
    if (sourceName === "") return "Auto brightness on - detecting light source..."
    return "Auto brightness on - following " + sourceName
  }

  // A paused switch resumes rather than turning the feature off: clicking a
  // control that says "paused" means "carry on", not "give up".
  onPressed: function(button) {
    if (!root.service) return
    if (root.paused) {
      root.service.resume()
      return
    }
    root.service.toggle()
  }
}
