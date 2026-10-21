"""Independent OpenCV decode check, local PNG fixtures only; no URL is opened."""
import argparse
import json
from pathlib import Path
import cv2

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
args = parser.parse_args()
manifest = json.loads((args.directory / "renderer-results.json").read_text())
results = []
for entry in manifest["images"]:
    original = cv2.imread(str(args.directory / entry["file"]))
    if original is None:
        raise RuntimeError(f"Missing actual PNG: {entry['file']}")
    ok, jpg = cv2.imencode(".jpg", original, [cv2.IMWRITE_JPEG_QUALITY, 75])
    assert ok
    transforms = {
        "original-640": original,
        "resize-320": cv2.resize(original, (320, 320), interpolation=cv2.INTER_AREA),
        "resize-240": cv2.resize(original, (240, 240), interpolation=cv2.INTER_AREA),
        "resize-160": cv2.resize(original, (160, 160), interpolation=cv2.INTER_AREA),
        "rotate-90": cv2.rotate(original, cv2.ROTATE_90_CLOCKWISE),
        "jpeg-75": cv2.imdecode(jpg, cv2.IMREAD_COLOR),
    }
    for name, image in transforms.items():
        decoded, corners, _ = cv2.QRCodeDetector().detectAndDecode(image)
        results.append({"id": entry["id"], "file": entry["file"], "maskPattern": entry.get("maskPattern"), "transform": name, "passed": decoded == entry["text"], "detected": corners is not None, "decoded": decoded})
report = {"decoder": "OpenCV", "version": cv2.__version__, "imageCount": len(manifest["images"]), "caseCount": len(results), "passed": sum(row["passed"] for row in results), "failed": sum(not row["passed"] for row in results), "cases": results, "limitations": "Software image decoding only, not a phone-camera/print guarantee. No URL was opened and no scan was recorded."}
(args.directory / "opencv-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({key: report[key] for key in ["decoder", "version", "imageCount", "caseCount", "passed", "failed"]}, ensure_ascii=False))
for row in results:
    if not row["passed"]:
        print(json.dumps(row, ensure_ascii=False))
raise SystemExit(1 if report["failed"] else 0)
