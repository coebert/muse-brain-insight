"""Extract real EEG without joining discontinuous Cambridge epochs or Oslo recording runs."""

import configparser
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import io
import json
from pathlib import Path
import struct
import sys
import time
import zipfile
import zlib

import h5py
import numpy as np
import pandas as pd
import requests
from scipy import signal
from scipy.io import loadmat
from acquisitions import cache_name, parse_source_path
from waveforms import PAIRS, features

CAM_URL = "https://api.repository.cam.ac.uk/server/api/core/bitstreams/e94a6722-da5b-4e53-8673-5e8ec106e0f7/content"
CAM_SIZE = 3694326663
OSLO_REPO = "OpenNeuroDatasets/ds005620"
OSLO_TAG = "1.0.0"
OSLO_S3 = "https://s3.amazonaws.com/openneuro.org/ds005620"
REGIONS = PAIRS[:6]


def get(url, start=None, end=None):
    headers = {} if start is None else {"Range": f"bytes={start}-{end}"}
    for attempt in range(5):
        try:
            with requests.get(url, headers=headers, stream=True, timeout=(20, 100)) as r:
                r.raise_for_status()
                if start is not None:
                    if r.status_code != 206 or not r.headers.get("Content-Range", "").startswith(
                        f"bytes {start}-{end}/"
                    ):
                        raise ValueError("unexpected byte range")
                data = r.content
                if start is not None and len(data) != end - start + 1:
                    raise ValueError("incomplete HTTP range")
                return data
        except (ValueError, requests.RequestException):
            if attempt == 4:
                raise
            time.sleep(1 + attempt)


def bipolar(records, names):
    names = [x.upper() for x in names]
    for a, b in REGIONS:
        if names.count(a) != 1 or names.count(b) != 1:
            raise ValueError("missing or duplicate electrodes")
    return np.stack([records[names.index(a)] - records[names.index(b)] for a, b in REGIONS])


def cambridge(out):
    offset = CAM_SIZE - 65536
    directory = zipfile.ZipFile(io.BytesIO(get(CAM_URL, offset, CAM_SIZE - 1)))

    def member(filename):
        i = directory.getinfo("Sedation-RestingState/" + filename)
        start = i.header_offset + offset
        raw = get(
            CAM_URL,
            start,
            min(CAM_SIZE - 1, start + 30 + len(i.filename.encode()) + 1024 + i.compress_size),
        )
        head = struct.unpack_from("<4s5H3I2H", raw)
        if head[0] != b"PK\x03\x04":
            raise ValueError("invalid ZIP record")
        begin = 30 + head[-1] + head[-2]
        data = raw[begin : begin + i.compress_size]
        if i.compress_type == 8:
            data = zlib.decompress(data, -15)
        if len(data) != i.file_size or zlib.crc32(data) != i.CRC:
            raise ValueError("ZIP member checksum mismatch")
        return data

    info = loadmat(io.BytesIO(member("datainfo.mat")), simplify_cells=True)["datainfo"]

    def one(row):
        base, level, concentration, rt, correct = row
        dest = out / f"{base[:2]}-{int(level)}.npz"
        if dest.exists():
            return
        with h5py.File(io.BytesIO(member(base + ".set"))) as f:
            eeg = f["EEG"]
            keys = [
                "".join(map(chr, f[ref][...].ravel()))
                for ref in eeg["chanlocs"]["labels"][...].ravel()
            ]
            n, pnts, trials, hz = [int(eeg[k][0, 0]) for k in ("nbchan", "pnts", "trials", "srate")]
            data_name = "".join(map(chr, eeg["data"][...].ravel()))
        if data_name != base + ".fdt" or pnts / hz != 10 or n != len(keys):
            raise ValueError("unexpected EEGLAB layout")
        data = np.frombuffer(member(data_name), dtype="<f4").reshape(trials, pnts, n)
        # One centered eight-second window per separately cleaned 10 s source epoch.
        rows = []
        for trial in data:
            cropped = bipolar(trial.T, keys)[:, hz : 9 * hz]
            # Identical 125 Hz signal representation in both studies.
            frac = Fraction(125, hz)
            rows.append(
                features(
                    signal.resample_poly(cropped, frac.numerator, frac.denominator, axis=1), 125
                )[0]
            )
        np.savez_compressed(dest, x=rows, correct=int(correct), concentration=float(concentration))
        print("Cambridge", dest.stem, len(rows), flush=True)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(one, info))


def oslo(out, eyes_open_only=False):
    api = "https://api.github.com/repos/" + OSLO_REPO
    paths = [
        r["path"] for r in json.loads(get(api + "/git/trees/" + OSLO_TAG + "?recursive=1"))["tree"]
    ]
    root = "https://raw.githubusercontent.com/" + OSLO_REPO + "/" + OSLO_TAG + "/"
    pts = pd.read_csv(io.BytesIO(get(root + "participants.tsv")), sep="\t")
    excluded = {
        s.split("_")[-1]
        for s in pts.loc[pts.excluded.astype(str).str.lower() == "true", "participant_id"]
    }
    bad = dict(
        zip(pts.participant_id.str.split("_").str[-1], pts.bad_after_preprocessing.astype(str))
    )
    chosen = []
    for path in paths:
        # Anchored against the pinned release grammar: only the three extracted
        # acquisitions are selected, and an unrecognised name is skipped rather
        # than assigned a stage by suffix.
        entry = parse_source_path(path)
        if entry is None:
            continue
        if eyes_open_only != (entry["stage"] == "eyes_open"):
            continue
        if entry["subject"] in excluded:
            continue
        if ("task-" + entry["condition"]) in bad.get(entry["subject"], ""):
            continue
        chosen.append((entry, path))

    def one(row):
        entry, path = row
        dest = out / (cache_name(entry) + ".npz")
        if dest.exists():
            return
        header = configparser.ConfigParser(
            interpolation=None, inline_comment_prefixes=(";",), strict=False
        )
        h = get(OSLO_S3 + "/" + path).decode("utf-8-sig")
        header.read_string(h[h.index("[Common Infos]") :].split("[Comment]")[0])
        c = header["Common Infos"]
        n = c.getint("NumberOfChannels")
        hz = round(1e6 / c.getfloat("SamplingInterval"))
        if (
            c["DataOrientation"] != "MULTIPLEXED"
            or header["Binary Infos"]["BinaryFormat"] != "IEEE_FLOAT_32"
        ):
            raise ValueError("unknown binary layout")
        channels = [header["Channel Infos"][f"Ch{i+1}"].split(",") for i in range(n)]
        names = [v[0].upper() for v in channels]
        use = [names.index(s) for pair in REGIONS for s in pair]
        if any(channels[i][3].lower().replace("µ", "u").replace("μ", "u") != "uv" for i in use):
            raise ValueError("incompatible physical unit")
        base = path.rsplit("/", 1)[0] + "/" + c["DataFile"]
        first = 6 * hz * n * 4
        length = 32 * hz * n * 4
        raw = get(OSLO_S3 + "/" + base, first, first + length - 1)
        mat = np.frombuffer(raw, "<f4").reshape(-1, n).T
        # Scale electrodes separately before forming differences.
        subset = mat[use] * np.array([float(channels[i][2]) for i in use])[:, None]
        b = subset[::2] - subset[1::2]
        frac = Fraction(125, hz)
        x = features(signal.resample_poly(b, frac.numerator, frac.denominator, axis=1), 125)
        ch_tsv = pd.read_csv(
            io.BytesIO(get(OSLO_S3 + "/" + path.replace("_eeg.vhdr", "_channels.tsv"))), sep="\t"
        )
        if "status" in ch_tsv:
            badch = set(
                ch_tsv.loc[ch_tsv.status.astype(str).str.lower() == "bad", "name"].str.upper()
            )
            for j, pair in enumerate(REGIONS):
                if badch.intersection(pair):
                    x[:, j, :] = np.nan
        np.savez_compressed(
            dest,
            x=x,
            subject=entry["subject"],
            task=entry["task"],
            acq=entry["acq"],
            run=-1 if entry["run"] is None else entry["run"],
            condition=entry["condition"],
            source=path,
        )
        print("Oslo", dest.stem, len(x), flush=True)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(one, chosen))


if __name__ == "__main__":
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == "oslo-eyes-open":
        oslo(out, eyes_open_only=True)
    else:
        {"cambridge": cambridge, "oslo": oslo}[sys.argv[1]](out)
