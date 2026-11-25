#!/usr/bin/env python3
"""Generate the applet's panel icons: a ring filled up to the charge limit,
with a lightning bolt inside. One icon per 5% step from 50% to 100%.

    python3 tools/make-icons.py
"""
import math
from pathlib import Path

OUT = next((Path(__file__).resolve().parent.parent / "applet").glob("*@*")) / "icons"
CX = CY = 8.0
R_OUT, R_IN = 7.0, 5.5
BOLT = "M8.9 3.9L5.6 8.7h2.2l-.7 3.5 3.3-4.8H8.2z"


def pt(r, frac):
    """Point on a circle, clockwise from 12 o'clock."""
    a = 2 * math.pi * frac
    return CX + r * math.sin(a), CY - r * math.cos(a)


def ring(frac):
    if frac >= 1:
        return ('<path fill-rule="evenodd" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1z'
                'm0 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/>')
    large = 1 if frac > 0.5 else 0
    ox, oy = pt(R_OUT, frac)
    ix, iy = pt(R_IN, frac)
    return (f'<path d="M{CX:g} {CY - R_OUT:g}A{R_OUT:g} {R_OUT:g} 0 {large} 1 {ox:.3f} {oy:.3f}'
            f'L{ix:.3f} {iy:.3f}A{R_IN:g} {R_IN:g} 0 {large} 0 {CX:g} {CY - R_IN:g}z"/>')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("charge-*-symbolic.svg"):
        old.unlink()
    for level in range(50, 101, 5):
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">'
               f'<g fill="#bebebe">{ring(level / 100)}<path d="{BOLT}"/></g></svg>\n')
        (OUT / f"charge-limit-{level}-symbolic.svg").write_text(svg)
    print(f"Wrote 11 icons to {OUT}")


if __name__ == "__main__":
    main()
