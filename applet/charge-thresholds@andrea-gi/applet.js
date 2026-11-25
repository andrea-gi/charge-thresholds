// Battery Charge Limit: Cinnamon applet for TLP charge thresholds.
//
// Reads state without privileges (sysfs + the TLP drop-in). Changes go through
// `pkexec HELPER apply|persist START STOP` (argv array, no shell); the helper
// validates everything again.

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;

const PKEXEC = "/usr/bin/pkexec";
const HELPER = "/usr/local/libexec/charge-thresholds-helper";
const DROPIN = "/etc/tlp.d/90-charge-thresholds.conf";
const POWER_SUPPLY = "/sys/class/power_supply";

const MIN_STOP = 50;    // same limits as the helper
const MAX_START = 95;
const MIN_GAP = 5;
const STEP = 5;
const FULL = { start: 0, stop: 100 };

// The menu is wider than the Custom sliders + sub-menu indent, so opening
// Custom only makes it taller.
const MENU_WIDTH_EM = 22;
const SLIDER_WIDTH_EM = 12;

const PKEXEC_CANCELLED = [126, 127];   // password dialog dismissed / failed

// Same rule as the helper: first BAT0/BAT1/BATT/BATC/CMB0 with a stop threshold.
function detectBattery() {
    try {
        const names = [];
        const en = Gio.File.new_for_path(POWER_SUPPLY).enumerate_children(
            "standard::name", Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null)
            names.push(info.get_name());
        en.close(null);
        for (const name of names.sort()) {
            if (!/^(BAT[0-9]|BATT|BATC|CMB[0-9])$/.test(name)) continue;
            const dir = POWER_SUPPLY + "/" + name + "/";
            if (GLib.file_test(dir + "charge_control_end_threshold", GLib.FileTest.EXISTS))
                return {
                    dir,
                    key: name === "BAT1" ? "BAT1" : "BAT0",
                    hasStart: GLib.file_test(dir + "charge_control_start_threshold", GLib.FileTest.EXISTS),
                };
        }
    } catch (e) {
        global.logError("charge-thresholds: " + e.message);
    }
    return null;
}

function readText(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            try {
                resolve(new TextDecoder().decode(file.load_contents_finish(res)[1]));
            } catch (e) {
                resolve(null);
            }
        });
    });
}

function toInt(text) {
    const n = text === null ? NaN : parseInt(text.trim(), 10);
    return Number.isInteger(n) ? n : null;
}

// Start 0 means "vendor default", so only stop is compared then.
function sameLimits(a, b) {
    return !!a && !!b && a.stop === b.stop && (b.start === 0 || a.start === b.start);
}

// Ring filled up to the stop limit (icons for 50, 55 ... 100).
function iconForStop(stop) {
    return "charge-limit-" + Math.min(100, Math.max(MIN_STOP, Math.floor(stop / STEP) * STEP)) + "-symbolic";
}

function describe(l) {
    if (l.stop >= 100) return "Charges to 100%";
    if (!l.start) return "Stops at %d%%".format(l.stop);
    return "Stops at %d%%, resumes below %d%%".format(l.stop, l.start);
}

function describeShort(l) {
    if (l.stop >= 100) return "100%";
    return l.start ? "%d-%d%%".format(l.start, l.stop) : "%d%%".format(l.stop);
}

class ChargeLimitApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.metadata = metadata;
        this._bat = detectBattery();
        this._current = null;   // {start, stop} from sysfs
        this._saved = null;     // {start, stop} from the drop-in
        this._busy = false;
        this._destroyed = false;
        this._timerId = 0;
        this._customStart = this._bat && this._bat.hasStart ? 70 : 0;
        this._customStop = 85;

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("save-start", "saveStart", () => this._onPresetChanged());
        this.settings.bind("save-stop", "saveStop", () => this._onPresetChanged());
        this.settings.bind("refresh-interval", "refreshInterval", () => this._startTimer());

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.box.set_style("min-width: " + MENU_WIDTH_EM + "em;");
        this._buildMenu();
        this.menu.connect("open-state-changed", (menu, open) => {
            if (open) {
                this._syncSliders();
                this._refresh();
            }
        });

        this._setIcon(iconForStop(100));
        this._startTimer();
        this._refresh();
    }

    // ---------- menu ----------

    _buildMenu() {
        const title = new PopupMenu.PopupMenuItem("Battery charge limit", { reactive: false });
        title.label.set_style("font-weight: bold;");
        this.menu.addMenuItem(title);

        this._statusItem = new PopupMenu.PopupMenuItem("", { reactive: false });
        this.menu.addMenuItem(this._statusItem);
        this._persistItem = new PopupMenu.PopupMenuItem("", { reactive: false });
        this._persistItem.label.set_style("font-size: smaller;");
        this.menu.addMenuItem(this._persistItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._saveItem = new PopupMenu.PopupMenuItem("");
        this._saveItem.connect("activate", () => this._run("apply", this._savePreset()));
        this.menu.addMenuItem(this._saveItem);

        this._fullItem = new PopupMenu.PopupMenuItem("Full charge   100%");
        this._fullItem.connect("activate", () => this._run("apply", FULL));
        this.menu.addMenuItem(this._fullItem);

        this._customItem = new PopupMenu.PopupSubMenuMenuItem("Custom");
        this.menu.addMenuItem(this._customItem);
        const sub = this._customItem.menu;

        // Laptops with only a stop threshold get just the stop slider.
        const hasStart = !!this._bat && this._bat.hasStart;
        this._startLabel = new PopupMenu.PopupMenuItem("", { reactive: false });
        this._startSlider = new PopupMenu.PopupSliderMenuItem(0);
        this._stopLabel = new PopupMenu.PopupMenuItem("", { reactive: false });
        this._stopSlider = new PopupMenu.PopupSliderMenuItem(1);
        this._stopSlider.set_mark(MIN_STOP / 100);   // lowest allowed stop
        for (const item of hasStart
            ? [this._startLabel, this._startSlider, this._stopLabel, this._stopSlider]
            : [this._stopLabel, this._stopSlider])
            sub.addMenuItem(item);
        for (const s of [this._startSlider, this._stopSlider])
            s._slider.set_style("min-width: " + SLIDER_WIDTH_EM + "em;");
        this._startSlider.connect("value-changed", (s, v) => this._onStartSlider(v));
        this._stopSlider.connect("value-changed", (s, v) => this._onStopSlider(v));

        this._applyCustom = new PopupMenu.PopupMenuItem("Apply");
        this._applyCustom.connect("activate",
            () => this._run("apply", { start: this._customStart, stop: this._customStop }));
        sub.addMenuItem(this._applyCustom);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._keepItem = new PopupMenu.PopupIconMenuItem(
            "Keep after reboot", "document-save-symbolic", St.IconType.SYMBOLIC);
        this._keepItem.connect("activate", () => {
            // Full is saved as 0/100 (vendor default), not the firmware's start value.
            if (this._current)
                this._run("persist", this._current.stop >= 100 ? FULL : this._current);
        });
        this.menu.addMenuItem(this._keepItem);

        this._onPresetChanged();
        this._showSliders();
    }

    _savePreset() {
        const stop = Math.min(100, Math.max(MIN_STOP, this.saveStop));
        const start = this._bat && this._bat.hasStart
            ? Math.min(stop - MIN_GAP, Math.max(0, this.saveStart)) : 0;
        return { start, stop };
    }

    _onPresetChanged() {
        if (!this._saveItem) return;
        this._saveItem.setLabel("Save battery   " + describeShort(this._savePreset()));
        this._updateUi();
    }

    // ---------- sliders: same 0-100% scale, 5% steps ----------

    _snap(v, lo, hi) {
        return Math.min(hi, Math.max(lo, Math.round((v * 100) / STEP) * STEP));
    }

    _onStartSlider(v) {
        this._customStart = this._snap(v, 0, MAX_START);
        if (this._customStart > this._customStop - MIN_GAP)
            this._customStop = Math.max(MIN_STOP, this._customStart + MIN_GAP);
        this._showSliders();
    }

    _onStopSlider(v) {
        this._customStop = this._snap(v, MIN_STOP, 100);
        if (this._customStart > this._customStop - MIN_GAP)
            this._customStart = this._customStop - MIN_GAP;
        this._showSliders();
    }

    _syncSliders() {
        if (this._current && this._current.stop < 100) {
            this._customStart = Math.min(this._current.start, this._current.stop - MIN_GAP);
            this._customStop = this._current.stop;
        }
        this._showSliders();
    }

    _showSliders() {
        this._startSlider.setValue(this._customStart / 100);
        this._stopSlider.setValue(this._customStop / 100);
        this._startLabel.setLabel("Resume charging below   %d%%".format(this._customStart));
        this._stopLabel.setLabel("Stop charging at   %d%%".format(this._customStop));
    }

    // ---------- state ----------

    _startTimer() {
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            Math.max(10, this.refreshInterval || 60), () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    async _refresh() {
        const bat = this._bat;
        if (!bat) {
            this._updateUi();
            return;
        }
        const [startText, stopText, dropin] = await Promise.all([
            bat.hasStart ? readText(bat.dir + "charge_control_start_threshold") : Promise.resolve("0"),
            readText(bat.dir + "charge_control_end_threshold"),
            readText(DROPIN),
        ]);
        if (this._destroyed) return;

        const start = toInt(startText), stop = toInt(stopText);
        this._current = start !== null && stop !== null ? { start, stop } : null;

        this._saved = null;
        if (dropin !== null) {
            const s = dropin.match(new RegExp("^START_CHARGE_THRESH_" + bat.key + "=(\\d+)", "m"));
            const e = dropin.match(new RegExp("^STOP_CHARGE_THRESH_" + bat.key + "=(\\d+)", "m"));
            if (s && e) this._saved = { start: parseInt(s[1], 10), stop: parseInt(e[1], 10) };
        }
        this._updateUi();
    }

    _updateUi() {
        if (!this._statusItem) return;
        const helperOk = GLib.file_test(HELPER, GLib.FileTest.IS_EXECUTABLE);
        const cur = this._current;

        let note = "";
        if (!cur)
            this._statusItem.setLabel(this._bat ? "Reading battery..." : "No battery with charge limit support");
        else {
            this._statusItem.setLabel(describe(cur));
            if (!helperOk)
                note = "Helper not installed - run install-system.sh";
            else if (sameLimits(cur, this._saved))
                note = "Saved · kept after reboot";
            else if (this._saved)
                note = "Until reboot · saved setting: " + describeShort(this._saved);
            else
                note = "Until reboot · no saved setting";
        }
        this._persistItem.setLabel(note);

        const isSave = sameLimits(cur, this._savePreset());
        const isFull = !!cur && !isSave && cur.stop >= 100;
        const isCustom = !!cur && !isSave && !isFull;
        this._saveItem.setOrnament(PopupMenu.OrnamentType.DOT, isSave);
        this._fullItem.setOrnament(PopupMenu.OrnamentType.DOT, isFull);
        this._customItem.label.set_text(isCustom ? "Custom   " + describeShort(cur) : "Custom");

        const enabled = !!cur && helperOk && !this._busy;
        for (const item of [this._saveItem, this._fullItem, this._customItem, this._applyCustom, this._keepItem])
            item.setSensitive(enabled);
        this._keepItem.actor.visible = !!cur && !sameLimits(cur, this._saved);

        this._setIcon(iconForStop(cur ? cur.stop : 100));
        this.set_applet_tooltip(cur ? describe(cur) + "\n" + note : "Battery charge limit");
    }

    _setIcon(name) {
        if (this._iconName === name) return;
        this._iconName = name;
        this.set_applet_icon_symbolic_path(this.metadata.path + "/icons/" + name + ".svg");
    }

    // ---------- privileged action ----------

    _run(cmd, limits) {
        if (this._busy) return;
        this._busy = true;
        this._updateUi();

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [PKEXEC, HELPER, cmd, String(limits.start), String(limits.stop)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._finish(null, e.message, limits, cmd);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            let stderr = "";
            try {
                stderr = p.communicate_utf8_finish(res)[2] || "";
            } catch (e) {
                stderr = e.message;
            }
            this._finish(p.get_if_exited() ? p.get_exit_status() : -1, stderr, limits, cmd);
        });
    }

    _finish(code, stderr, limits, cmd) {
        this._busy = false;
        if (this._destroyed) return;
        if (code === 0) {
            Main.notify("Battery charge limit",
                describe(limits) + " · " + (cmd === "persist" ? "kept after reboot" : "until reboot"));
        } else if (!PKEXEC_CANCELLED.includes(code)) {
            const lines = stderr.trim().split("\n");
            Main.notifyError("Could not change battery charge limit",
                lines.filter(l => l.startsWith("Error:")).pop() || stderr.trim() || "Unknown error");
        }
        this._refresh();
    }

    // ---------- lifecycle ----------

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        this._destroyed = true;
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = 0;
        this.settings.finalize();
        this.menu.destroy();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ChargeLimitApplet(metadata, orientation, panelHeight, instanceId);
}
