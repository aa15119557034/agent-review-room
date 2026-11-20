"""Verify the two six-face HDR payloads on the CPU. Requires Python, NumPy and Pillow."""
import argparse
import gzip
import hashlib
import io
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image


HERE = Path(__file__).resolve().parent
FACES = ("px", "nx", "py", "ny", "pz", "nz")
AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]


def check(condition, explanation):
    if not condition:
        raise ValueError(explanation)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_file(name):
    data = (HERE / name).read_bytes()
    return json.loads(gzip.decompress(data) if str(name).endswith(".gz") else data)


def read_fixture(fixture, manifest, revision, path, expected):
    local = fixture / path
    if local.is_file():
        data = local.read_bytes()
        if sha(data) == expected:
            return data
    data = subprocess.check_output(["git", "show", f"{revision}:{manifest['fixturePath']}/{path}"], cwd=fixture)
    check(sha(data) == expected, path)
    return data


def array(raw):
    check(len(raw) == 256 * 256 * 4 * 2, "invalid RGBA16F face length")
    result = np.frombuffer(raw, dtype="<f2").reshape(256, 256, 4)
    check(np.isfinite(result).all(), "nonfinite half-float")
    return result[:, :, :3].astype(np.float64)


def color(rgb, old_channel_limit=False):
    check((rgb >= 0).all(), "negative raw RGB")
    peak = rgb.max(axis=2)
    mapped = np.minimum(rgb, 2) if old_channel_limit else rgb / np.maximum(1, peak[:, :, None] / 2)
    check(np.array_equal(rgb[peak <= 2], mapped[peak <= 2]), "sub-limit RGB altered")
    check(mapped.min() >= 0 and mapped.max() <= 2, "mapped RGB limit")
    x = mapped / 2
    encoded = np.floor(255 * np.where(x <= .0031308, x * 12.92, 1.055 * x ** (1/2.4) - .055) + .5).astype(np.uint8)
    s = encoded.astype(np.float64) / 255
    decoded = 2 * np.where(s <= .04045, s/12.92, ((s+.055)/1.055)**2.4)
    check(decoded.max() <= 2, "decoded RGB limit")
    return encoded, float(np.abs(mapped - decoded).max()), int((peak > 2).sum()), float(peak.max())


def geometry(report):
    p = report["preparation"]
    check(p["dimensions"] == [256, 256] and p["edgesMatch"], "cubemap dimensions or seams")
    check(np.allclose(p["origin"]["stationLocal"], [0, 2.264, 18]) and np.allclose(p["origin"]["world"], [280, 10.264, 918]), "probe origin")
    check(len(p["rayEquivalence"]) == 6 and all(a["minDot"] > 1-1e-10 for a in p["rayEquivalence"]), "nine reference rays per camera")
    edges = {(s["face"], tuple(s["ndc"])): s["neighbor"] for s in p["edges"]}
    check(len(edges) == 24, "six quadrilateral face borders")
    for key, neighbor in edges.items():
        paired = edges[(neighbor["face"], tuple(neighbor["ndc"]))]
        check((paired["face"],tuple(paired["ndc"])) == key and neighbor["dot"] > 1-1e-10, "mismatched face borders")
    for face, axis, row in zip(FACES, AXES, report["faces"], strict=True):
        matrix = np.array(row["camera"]["matrixWorld"]).reshape(4,4).T
        proj = np.array(row["camera"]["projectionMatrix"]).reshape(4,4).T
        check(row["name"] == face and row["glError"] == 0 and row["time"] == 14, face+" clock or GL")
        check(np.allclose(-matrix[:3,2], axis) and np.allclose(matrix[:3,3], p["origin"]["world"]), face+" pose")
        check(np.isclose(np.linalg.det(matrix[:3,:3]),1) and np.allclose([proj[0,0],proj[1,1]],[1,1]), face+" projection")
    check(report["restore"]["equal"] and report["restore"]["gateResumed"] and report["restore"]["glError"] == 0, "restore")


def run(portable):
    manifest = json_file("manifest.json")
    fixture = None if portable else next((p for p in HERE.parents if (p/"scripts/baseline.cjs").is_file() and (p/"src/street-env").is_dir()),None)
    check(portable or fixture is not None, "Run in the fixture or pass --portable for a detached copy")
    for name, item in manifest["files"].items():
        packed = (HERE/name).read_bytes()
        check(len(packed) == item["bytes"] and sha(packed) == item["sha256"], name)
        if "uncompressedSHA256" in item:
            check(sha(gzip.decompress(packed)) == item["uncompressedSHA256"], name+" uncompressed")
    history = json_file("previous/verified-history.json")
    evidence = json_file("runtime-and-transport.json")
    result = {"storedFileIntegrity":len(manifest["files"]), "verifiedInstalledPNGs":0, "verifiedFinalRawFaces":0, "verifiedOldRawFaces":0,
              "verifiedInitialSignedFaces":0, "profiles":{}, "strictTransport":{}}
    for tag, receipt in evidence.items():
        native = json_file(receipt["nativeReport"])
        check(native["config"]["head"] == receipt["head"] and native["stage"] == "complete", tag)
        strict_clean = not (native["networkFailures"] or native["httpErrors"])
        check(strict_clean == receipt["strictTransportClean"], tag+" strict transport")
        check(native["transportClean"] == receipt["nativeTransportClean"] and native["ok"] == receipt["nativeOK"], tag+" authored transport")
        check(len(native["networkFailures"]) == len(receipt["rawCDPFailures"]) and all(s["canceled"] for s in native["networkFailures"]), tag+" raw failures")
        sub = Path(receipt["nativeReport"]).parent
        check(json_file(sub/"process-exit.json.gz") == receipt["process"] and json_file(sub/"source-manifest.json.gz")["head"] == receipt["head"], tag+" process/source receipt")
        geometry(native)
        r = native["reflectionUse"]
        check(r["sharedGlass"] == r["glazedMeshes"] == 8 and r["wetUniformAvailable"] and r["wetCubeShared"], tag+" cube sharing")
        check(r["reflectionStats"]["panes"] == {"W1":8,"W2":5,"E1":4,"E2":5,"E3":5},tag+" windows")
        check(r["reflectionStats"]["captures"] == r["reflectionStats"]["passesPerFrame"] == r["wetStats"]["extraPasses"] == r["wetStats"]["extraRenderTargets"] == 0, tag+" runtime capture cost")
        result["strictTransport"][tag] = {"exit":receipt["process"]["code"],"canceled":len(native["networkFailures"]),"strictClean":strict_clean}
    for profile, target in manifest["profileDirectories"].items():
        physical = json_file(f"{profile}/physical-only.json")
        baked = json_file(f"{profile}/bake-report.json.gz")
        initial = json_file(f"initial/{profile}/bake-report.json.gz")
        old = history[profile]
        check(physical["source"] == manifest["sourceFix"] and old["baselinePNGRevision"] == manifest["priorStored"], profile+" heads")
        seat = Image.open(HERE/profile/"six-faces.png").convert("RGB")
        check(seat.size == (1024, 852), profile+" panel dimensions")
        over, peak, quant_error = 0, 0.0, 0.0
        for i, face in enumerate(FACES):
            label = profile+"/"+face
            now = physical["faces"][face]
            old_row = old["faces"][face]
            raw = gzip.decompress((HERE/profile/(face+".rgba16f.gz")).read_bytes())
            check(sha(raw) == now["rawSHA256"] == baked["faces"][i]["rawSha256"], label+" hash")
            rgb = array(raw)
            encoded, quant, limited, high = color(rgb)
            check(abs(quant-now["maxQuantizationError"]) < 1e-12 and quant<.009 and limited == now["rawOver2Texels"] and high == now["rawPeak"], label+" physical values")
            over += limited
            peak = max(peak, high)
            quant_error = max(quant_error, quant)
            x, y = (i%2)*512, (i//2)*284+28
            check(np.array_equal(encoded, np.array(seat.crop((x+256,y,x+512,y+256)))), label+" panel right")
            if fixture:
                for revision, expected_hash, offset in [(manifest["installedPNG"],now["pngSHA256"],256),(manifest["priorStored"],old_row["pngSHA256"],0)]:
                    data = read_fixture(fixture,manifest,revision,f"src/{target}/{face}.png",expected_hash)
                    with Image.open(io.BytesIO(data)) as im:
                        original = np.array(im.convert("RGBA"))
                    check((original[:,:,3] == 255).all() and np.array_equal(original[:,:,:3],np.array(seat.crop((x+offset,y,x+offset+256,y+256)))), label+" PNG registration")
                result["verifiedInstalledPNGs"] += 1
            if "rawArchive" in old_row:
                earlier_archive = (HERE/old_row["rawArchive"]).read_bytes()
            elif fixture:
                earlier_archive = read_fixture(fixture,manifest,manifest["priorStored"],old_row["fixtureRawArchive"],old_row["archiveSHA256"])
            else:
                earlier_archive = None
            if earlier_archive is not None:
                earlier = gzip.decompress(earlier_archive)
                check(sha(earlier) == old_row["rawSHA256"],label+" old raw bytes")
                expected, _, _, _ = color(array(earlier), old["formula"]=="legacy-channel")
                check(np.array_equal(expected,np.array(seat.crop((x,y,x+256,y+256)))), label+" old panel left")
                result["verifiedOldRawFaces"] += 1
            if face == "nz":
                signed = gzip.decompress((HERE/"initial"/profile/"nz.rgba16f.gz").read_bytes())
                check(sha(signed) == initial["faces"][i]["rawSha256"], label+" initial signed face SHA")
                old_rgb = array(signed)
                check(np.argwhere(old_rgb < 0).tolist() == [[139,237,2]], label+" initial signed coordinate")
                check(old_rgb[139,237].tolist() == physical["pixel"]["priorLinearRGB"] and rgb[139,237].tolist() == physical["pixel"]["currentLinearRGB"],label+" fix pixel")
                result["verifiedInitialSignedFaces"] += 1
            result["verifiedFinalRawFaces"] += 1
        check(over == physical["rawOver2Texels"] and peak == physical["rawPeak"] and quant_error == physical["maxQuantizationError"], profile+" totals")
        result["profiles"][profile] = {"texels":6*256*256,"rawNegativeOrNonfinite":0,"rawPeak":peak,"rawTexelsOver2":over,
            "mappedOrDecodedTexelsOver2":0,"maxDecodedLinearError":quant_error}
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--portable",action="store_true",help="Verify the detached bundle using the 1:1 panel texels. Git and the historical evening raw archive are not needed.")
    opts = parser.parse_args()
    print(json.dumps(run(opts.portable),indent=2))
