#!/usr/bin/env python3
"""M7 virtual-cursor overlay.

A frameless, transparent, always-on-top, click-through fullscreen window that
smoothly animates a red dot to the coordinates the Rust worker publishes in
cursor_target.json immediately before it injects an action. Purely visual feedback:
killing this process at any time changes nothing else.

Usage: python scripts/overlay.py [path-to-json]
Deps:  pip install PyQt5
"""
import ctypes
import json
import sys
import time

from PyQt5.QtCore import QEasingCurve, QPointF, Qt, QTimer, QVariantAnimation
from PyQt5.QtGui import QBrush, QColor, QPainter, QPen, QRadialGradient
from PyQt5.QtWidgets import QApplication, QWidget

DEFAULT_TARGET_FILE = r"F:\dsh-workspace\dsh-computer-replacer\cursor_target.json"
POLL_MS = 30          # target-file poll interval
MOVE_MIN_MS = 80      # travel animation scales with distance
MOVE_MAX_MS = 480
SNAP_PX = 24          # below this a flight reads as a jitter, so it is placed, not animated
PULSE_S = 0.5         # click-arrival ring expansion time
FADE_AFTER_S = 20.0   # dim the dot after this long without updates


class Overlay(QWidget):
    def __init__(self, target_file: str) -> None:
        super().__init__()
        self.target_file = target_file
        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool  # no taskbar / alt-tab entry
            | Qt.WindowTransparentForInput  # mouse events pass through to windows below
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)  # never steal focus
        self.setAttribute(Qt.WA_TransparentForMouseEvents)

        self.pos = QPointF(0.0, 0.0)
        self.last_ts = -1.0
        self.last_seen = 0.0
        self.pulse_started = None  # time.monotonic() when a new target arrived
        self._anim_from = QPointF(0.0, 0.0)
        self._anim_to = QPointF(0.0, 0.0)

        self.anim = QVariantAnimation(self)
        self.anim.setStartValue(0.0)
        self.anim.setEndValue(1.0)
        self.anim.setEasingCurve(QEasingCurve.OutCubic)
        self.anim.valueChanged.connect(self._on_tick)

        self.timer = QTimer(self, interval=POLL_MS)
        self.timer.timeout.connect(self._poll)

    def showEvent(self, _event):
        # Cover the whole virtual desktop so multi-monitor targets stay visible.
        self.setGeometry(QApplication.primaryScreen().virtualGeometry())
        self.timer.start()

    def _poll(self):
        if self.pulse_started is not None:
            self.update()  # keep expanding the arrival ring after the move ends
        try:
            with open(self.target_file, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            ts = float(data["ts"])
            x, y = float(data["x"]), float(data["y"])
        except (OSError, ValueError, KeyError, TypeError):
            return  # missing / partially-written / malformed file: skip this frame
        if ts <= self.last_ts:
            return
        self.last_ts = ts
        self.last_seen = time.time()

        self._anim_from = QPointF(self.pos)
        self._anim_to = QPointF(x, y)
        travel = (self._anim_to - self._anim_from).manhattanLength()
        self.anim.stop()
        if travel < SNAP_PX:
            self.pos = QPointF(self._anim_to)  # too short to read as motion
        else:
            self.anim.setDuration(int(min(MOVE_MAX_MS, max(MOVE_MIN_MS, travel / 3))))
            self.anim.start()
        self.pulse_started = time.monotonic()
        self.update()

    def _on_tick(self, t):
        self.pos = self._anim_from + (self._anim_to - self._anim_from) * float(t)
        self.update()

    def paintEvent(self, _event):
        if self.last_ts < 0:
            return  # nothing published yet
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        idle = time.time() - self.last_seen > FADE_AFTER_S
        alpha = 60 if idle else 255

        if self.pulse_started is not None:
            t = (time.monotonic() - self.pulse_started) / PULSE_S
            if t >= 1.0:
                self.pulse_started = None
            else:
                radius = 8.0 + 26.0 * t
                ring = QColor(255, 60, 60, int(180 * (1.0 - t)))
                painter.setPen(QPen(ring, 3))
                painter.setBrush(Qt.NoBrush)
                painter.drawEllipse(self.pos, radius, radius)

        glow = QRadialGradient(self.pos, 16)
        glow.setColorAt(0.0, QColor(255, 40, 40, alpha * 45 // 100))
        glow.setColorAt(1.0, QColor(255, 40, 40, 0))
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(glow))
        painter.drawEllipse(self.pos, 16, 16)

        painter.setBrush(QColor(232, 29, 53, alpha))
        painter.setPen(QPen(QColor(255, 255, 255, alpha), 2))
        painter.drawEllipse(self.pos, 7.0, 7.0)
        painter.end()


def main():
    target_file = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TARGET_FILE
    # UIA publishes physical pixels; make this process per-monitor DPI aware and
    # keep Qt scaling off so the dot lands on the exact physical coordinate.
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, False)
    app = QApplication(sys.argv)
    overlay = Overlay(target_file)
    overlay.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
