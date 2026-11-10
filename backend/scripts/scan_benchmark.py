#!/usr/bin/env python3
"""Build the picture index and run the picture-matcher benchmark (docs/CARD_MATCH.md).

Run inside the backend container (or anywhere with DATABASE_URL pointing at the database):

    python scripts/scan_benchmark.py index                      # build / update the English picture index
    python scripts/scan_benchmark.py synthetic [--count 400]    # synthetic phone photos of ~400 cards
    python scripts/scan_benchmark.py labelled [--trace-dir D]   # the diagnostics traces with a confirmed answer
    python scripts/scan_benchmark.py all                        # index, synthetic, then labelled if traces exist

It prints a summary and writes the JSON report under CARD_MATCH_DIR/reports (what the Scanner lab shows).
Threads are capped by CARD_MATCH_THREADS (default 3).
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def summarise(report: dict) -> None:
    m = report["metrics"]
    print(f"\n{report['kind']} benchmark: {m['n']} photos, model {report['model']}, {report['duration_seconds']} s")
    print(f"  card found {m['card_found_pct']}%   top1 {m['top1_pct']}%  top5 {m['top5_pct']}%  top20 {m['top20_pct']}%")
    print(f"  number read exactly {m['number_exact_pct']}%   decided {m['decided_pct']}%   of those right {m['decided_right_pct']}%")
    for stage, row in report["timings_ms"].items():
        print(f"  {stage:<7} median {row['median']:>7} ms   p95 {row['p95']:>7} ms")
    print(f"  memory: extra {report['memory']['extra_mb']} MB (peak {report['memory']['peak_rss_mb']} MB)")
    for item in report["pass_bar"]:
        mark = {True: "PASS", False: "FAIL", None: "n/a "}[item["ok"]]
        print(f"  [{mark}] {item['label']}: {item['value']} (target {item['target']})")
    side = report.get("side_by_side")
    if side:
        for label, view in (("matcher re-run now", side["rerun"]), ("matcher as recorded at scan time", side.get("recorded"))):
            if not view:
                continue
            print(f"  vs Ollama on {view['n']} confirmed photos ({label}):")
            print(f"    matcher decided {view['matcher']['decided_pct']}% right {view['matcher']['right_pct']}%   Ollama decided {view['current']['decided_pct']}% right {view['current']['right_pct']}%")
            print(f"    decided differently on {view['differ']} of {view['both_decided']}: matcher right {view['differ_matcher_right']}, Ollama right {view['differ_current_right']}, neither {view['differ_neither_right']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=["index", "synthetic", "labelled", "all"])
    parser.add_argument("--count", type=int, default=400)
    parser.add_argument("--trace-dir")
    parser.add_argument("--data-dir", help="overrides CARD_MATCH_DIR")
    args = parser.parse_args()
    if args.data_dir:
        os.environ["CARD_MATCH_DIR"] = args.data_dir
    if args.trace_dir:
        os.environ["SCAN_TRACE_DIR"] = args.trace_dir

    from services.card_match import benchmark, config, jobs
    from services.card_match.model_specs import DEFAULT_MODEL

    config.lower_priority()
    config.apply_thread_caps()
    if args.mode in ("index", "all"):
        print(json.dumps(jobs.build_index_work(DEFAULT_MODEL), indent=2))
    for kind in ([args.mode] if args.mode in ("synthetic", "labelled") else ["synthetic", "labelled"] if args.mode == "all" else []):
        try:
            result = jobs.benchmark_work(kind, DEFAULT_MODEL, count=args.count)
        except RuntimeError as exc:
            print(f"{kind}: {exc}")
            if args.mode != "all":
                return 1
            continue
        report = json.loads((benchmark.reports_dir() / result["report"]).read_text(encoding="utf-8"))
        summarise(report)
        print(f"  report: {benchmark.reports_dir() / result['report']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
