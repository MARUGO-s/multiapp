"""Decode actual browser exports; preserve aspect ratio, never visit URLs."""
from pathlib import Path
import json
import cv2
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
root = parser.parse_args().directory
manifest = json.loads((root / 'caption-render-results.json').read_text())
expected = 'https://marugo-s.github.io/multiapp/?s=q#AbCd1234EfGh'
results = []
assert manifest['count'] == len(manifest['results'])
labels = {'default', 'custom', 'long-japanese-latin', 'unicode80', 'hidden', 'sns-unchanged', 'no-logo-unchanged'}
rows = [row for row in manifest['results'] if row['label'] in labels]
assert len(rows) == len({(row['id'], row['label']) for row in rows}) == 43
for row in rows:
    filename = f"{row['id'] or 'none'}-{row['label']}.png"
    original = cv2.imread(str(root / filename))
    assert original is not None and original.shape[1] == 640
    ok, jpg = cv2.imencode('.jpg', original, [cv2.IMWRITE_JPEG_QUALITY, 75])
    assert ok
    transforms = {'original': original, 'rotate90': cv2.rotate(original, cv2.ROTATE_90_CLOCKWISE), 'jpeg75': cv2.imdecode(jpg, cv2.IMREAD_COLOR)}
    for width in (320, 240, 160):
        transforms[f'width{width}'] = cv2.resize(original, (width, round(original.shape[0] * width / 640)), interpolation=cv2.INTER_AREA)
    for name, image in transforms.items():
        text, corners, _ = cv2.QRCodeDetector().detectAndDecode(image)
        results.append({'file': filename, 'transform': name, 'passed': text == expected, 'detected': corners is not None})
report = {'version': cv2.__version__, 'images': len(rows), 'cases': results, 'count': len(results), 'passed': sum(r['passed'] for r in results), 'failed': sum(not r['passed'] for r in results), 'aspectRatioPreserved': True, 'noNetwork': True}
(root / 'caption-opencv-results.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k,v in report.items() if k != 'cases'}))
for r in results:
    if not r['passed']: print(json.dumps(r))
raise SystemExit(bool(report['failed']))
