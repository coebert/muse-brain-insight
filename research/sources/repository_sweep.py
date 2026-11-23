"""Find EEG deposits and example waveform paths without retrieving participant recordings."""
import csv
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
import re
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree

PIN = "aa9ce696e9a01c087fef325ddeea542835987e97"
SUMMARY = "https://data.eegdash.org/api/eegdash/datasets/summary"
FALLBACK = f"https://raw.githubusercontent.com/EEGDash/EEGDash/{PIN}/eegdash/dataset/dataset_summary.csv"
WAVE = re.compile(r"^sub-[^/]+/(?:ses-[^/]+/)?(?:eeg|ieeg)/[^/]+_(?:eeg|ieeg)\.(?:edf|bdf|fdt|set|eeg|vhdr|cnt|vhdr|nwb)$", re.I)
NONHUMAN = re.compile(r"\b(?:mice|mouse|rats?|rodents?|pigs?|porcine|canine|dogs?|macaques?|monkeys?|non[- ]human primates?|baboons?|zebrafish)\b", re.I)
SYNTHETIC = re.compile(r"\b(?:synthetic|simulated EEG|EEG simulation|phantom)\b", re.I)
FORMATS = (".edf", ".bdf", ".eeg", ".fdt", ".set", ".cnt", ".nwb")


def fetch(url, github=False):
    headers = {"User-Agent": "MindGuard-EEG-research-source-index/1"}
    if github and os.getenv("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=headers), timeout=18) as response:
                return response.read()
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
        except OSError:
            if attempt == 2:
                raise
        time.sleep(1 + attempt)


def normalize_id(value):
    value = value.lower()
    hbn = re.fullmatch(r"eeg2025r(\d+)(?:mini)?", value)
    if hbn and 1 <= int(hbn[1]) <= 11:
        n = int(hbn[1])
        return f"ds{5504 + n + (n >= 9):06}"
    if re.fullmatch(r"on\d{6}", value):
        return "ds" + value[2:]
    return value if re.fullmatch(r"(?:ds|nm)\d{6}", value) else ""


def text_value(value):
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    return str(value or "")


def archive_rows():
    static = list(csv.DictReader(io.StringIO(fetch(FALLBACK).decode("utf-8-sig"))))
    rows = {r["dataset"].lower(): r for r in static}
    live_count = 0
    live_error = ""
    seen = set()
    try:
        while True:
            params = urlencode({"limit": 100, "skip": live_count})
            payload = json.loads(fetch(SUMMARY + "?" + params))
            page = payload["data"]
            if not isinstance(page, list):
                raise ValueError("unexpected response structure")
            if not page:
                break
            new_ids = set()
            for item in page:
                name = item["dataset_id"].lower()
                new_ids.add(name)
                previous = rows.get(name, {})
                row = {
                    "dataset": name,
                    "dataset_title": item.get("title") or item.get("name") or item.get("dataset_title"),
                    "record_modality": text_value(item.get("recording_modality")),
                    "license": text_value(item.get("license")),
                    "n_subjects": (item.get("demographics") or {}).get("subjects_count"),
                    "n_records": item.get("total_files"),
                    "doi": text_value(item.get("doi")),
                }
                rows[name] = {key: row.get(key) or previous.get(key, "") for key in row}
            if seen.issuperset(new_ids):
                raise ValueError("API repeated a page")
            seen.update(new_ids)
            live_count += len(page)
            if len(page) < 100:
                break
    except (KeyError, OSError, ValueError, TypeError) as error:
        live_error = str(error)
    stats = {"pinned_listing_rows": len(static), "live_rows_read": live_count,
             "live_error": live_error, "combined_listing_ids": len(rows)}
    return rows, stats


def eeg_groups(rows):
    by_accession = {}
    for key, row in rows.items():
        modalities = {v.strip().lower() for v in row["record_modality"].split(",")}
        if not modalities.intersection({"eeg", "ieeg"}):
            continue
        accession = normalize_id(key)
        if accession:
            by_accession.setdefault(accession, {})[key] = row
    return by_accession


def sample_path(paths):
    matches = sorted(p for p in paths if WAVE.fullmatch(p) and p.lower().endswith(FORMATS))
    return next((p for p in matches if not p.lower().endswith(".set")), next(iter(matches), ""))


def file_listing(accession):
    if accession.startswith("ds"):
        params = {"list-type": "2", "prefix": accession + "/sub-", "max-keys": 300}
        root = ElementTree.fromstring(fetch("https://s3.amazonaws.com/openneuro.org?" + urlencode(params)))
        keys = [e.text[len(accession) + 1:] for e in root.findall(".//{*}Key") if e.text]
        return sample_path(keys), "OpenNeuro S3 listing", ""
    repo = "nemarDatasets/" + accession
    result = json.loads(fetch(f"https://api.github.com/repos/{repo}/git/trees/HEAD?recursive=1", github=True))
    return sample_path(p["path"] for p in result["tree"] if p["type"] == "blob"), "NEMAR Git tree", result["sha"]


def entry(item):
    accession, variants = item
    key = next((k for k in (accession, "on" + accession[2:]) if k in variants), next(iter(variants)))
    row = variants[key]
    url = ("https://openneuro.org/datasets/" if accession.startswith("ds") else "https://nemar.org/dataset/") + accession
    try:
        path, method, tree = file_listing(accession)
        status = "waveform path listed" if path else "no matching example in inspected listing"
    except (OSError, ValueError, KeyError, ElementTree.ParseError) as error:
        method, tree, path = "", "", ""
        status = "listing unavailable: " + str(error)[:100]
    title = row.get("dataset_title", "")
    flag = "check nonhuman cohort" if NONHUMAN.search(title) else "check synthetic data" if SYNTHETIC.search(title) else "verify human cohort"
    return [accession, title, row["record_modality"], row.get("license", ""), row.get("n_subjects", ""),
            row.get("n_records", ""), url, ";".join(sorted(variants)), flag, status, method, tree, path]


def main():
    rows, stats = archive_rows()
    groups = eeg_groups(rows)
    header = ["accession", "title", "modalities", "reported_license", "reported_subjects", "reported_records",
              "provider_url", "source_ids", "population_review", "file_check", "listing_source", "listing_tree", "example_path"]
    with open("eeg-repository-index.csv", "w", newline="") as dest, ThreadPoolExecutor(max_workers=6) as pool:
        writer = csv.writer(dest)
        writer.writerow(header)
        hits = 0
        for record in pool.map(entry, sorted(groups.items())):
            writer.writerow(record)
            hits += bool(record[-1])
            if "--emit" in sys.argv:
                print("INDEXROW " + json.dumps(record, separators=(",", ":")), flush=True)
    print("INDEXSTATS " + json.dumps({**stats, "accessions": len(groups), "with_waveform_path": hits}), flush=True)


if __name__ == "__main__":
    main()
