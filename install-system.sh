#!/bin/bash
# Install or remove the root part (helper, polkit policy, TLP config).
#   sudo ./install-system.sh install|uninstall
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HELPER=/usr/local/libexec/charge-thresholds-helper
POLICY=/usr/share/polkit-1/actions/org.local.charge-thresholds.policy
DROPIN=/etc/tlp.d/90-charge-thresholds.conf
TLPCONF=/etc/tlp.conf
BACKUP=/etc/tlp.conf.pre-charge-thresholds

die() { echo "Error: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run with sudo: sudo $0 ${1:-install}"

do_install() {
    command -v tlp >/dev/null || die "TLP is not installed"
    command -v pkexec >/dev/null || die "pkexec is not installed (Debian/Ubuntu: apt install pkexec)"
    [[ -f $TLPCONF && -d /etc/tlp.d ]] || die "$TLPCONF or /etc/tlp.d not found (TLP 1.4+ needed)"
    read -r bat key < <("$HERE/system/charge-thresholds-helper" detect) \
        || die "no battery with charge threshold support found in /sys/class/power_supply"
    echo "Battery: $bat (TLP key $key)"

    install -D -o root -g root -m 755 "$HERE/system/charge-thresholds-helper" "$HELPER"
    install -o root -g root -m 644 "$HERE/system/org.local.charge-thresholds.policy" "$POLICY"

    # tlp.conf is read last and would override the drop-in: back it up once,
    # then comment out its active thresholds for this battery.
    [[ -e $BACKUP ]] || cp -a "$TLPCONF" "$BACKUP"
    sed -i -E "s/^((START|STOP)_CHARGE_THRESH_${key}=)/#\1/" "$TLPCONF"
    diff "$BACKUP" "$TLPCONF" || true

    for f in /etc/tlp.d/*.conf; do
        if [[ $f != "$DROPIN" ]] && grep -sqE "^(START|STOP)_CHARGE_THRESH_${key}=" "$f"; then
            echo "Warning: $f also sets thresholds and may override the applet"
        fi
    done

    # Initial saved setting: full charge. Never overwrites an existing one.
    [[ -e $DROPIN ]] || "$HELPER" persist 0 100 >/dev/null
    echo "Installed. Saved setting: $(grep -h '^S' "$DROPIN" | tr '\n' ' ')"
}

do_uninstall() {
    rm -f "$HELPER" "$POLICY" "$DROPIN"
    rmdir /usr/local/libexec 2>/dev/null || true
    if [[ -e $BACKUP ]]; then
        mv -f "$BACKUP" "$TLPCONF"
        echo "Restored $TLPCONF from backup"
    fi
    tlp setcharge >/dev/null 2>&1 || true   # re-apply thresholds from tlp.conf
    echo "Uninstalled."
}

case ${1:-} in
    install) do_install ;;
    uninstall) do_uninstall ;;
    *) echo "Usage: sudo $0 install|uninstall" >&2; exit 2 ;;
esac
