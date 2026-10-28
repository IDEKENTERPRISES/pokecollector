"""Streaks: consecutive local days the app was opened, with one automatic freeze a week.

Pure functions over a set of dates, so the rules are tested without a database. A single missed day
is bridged ("frozen") when no freeze was spent in the same ISO week yet; two missed days in a row, or
a second miss in the same week, end the run.
"""
from __future__ import annotations

import datetime

ONE_DAY = datetime.timedelta(days=1)


def _week(day: datetime.date) -> tuple[int, int]:
    iso = day.isocalendar()
    return iso[0], iso[1]


def compute_streak(active_days, today: datetime.date) -> dict:
    """The current and best streak, the days a freeze bridged and every day that counts toward a run.

    `current` is still alive when today is not opened yet but yesterday was (or can be frozen).
    `run_days` are the active days of runs that reached two days or more, for the streak XP.
    """
    days = sorted({day for day in active_days if day <= today})
    used_weeks: set[tuple[int, int]] = set()
    frozen: list[datetime.date] = []
    run: list[datetime.date] = []
    best = 0
    run_days: set[datetime.date] = set()
    last = None

    def close_run():
        nonlocal best
        best = max(best, len(run))
        if len(run) >= 2:
            run_days.update(run)

    for day in days:
        if last is not None:
            gap = (day - last).days
            missed = last + ONE_DAY
            if gap == 1:
                pass
            elif gap == 2 and _week(missed) not in used_weeks:
                used_weeks.add(_week(missed))
                frozen.append(missed)
            else:
                close_run()
                run = []
        run.append(day)
        last = day
    close_run()

    current = 0
    freeze_pending = False
    if last is not None:
        gap = (today - last).days
        if gap <= 1:
            current = len(run)
        elif gap == 2 and _week(last + ONE_DAY) not in used_weeks:
            current = len(run)  # yesterday was missed; opening today spends the weekly freeze
            freeze_pending = True
    return {
        "current": current,
        "best": best,
        "frozen_days": frozen,
        "run_days": sorted(run_days),
        "active_today": last == today,
        "freeze_available": _week(today) not in used_weeks and not freeze_pending,
        "freeze_pending": freeze_pending,
    }
