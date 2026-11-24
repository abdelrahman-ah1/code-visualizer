"""Regenerate the C++ example traces in frontend/public/examples/ (needs g++ and gdb). Run: python3 make_cpp_fixtures.py"""
import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from cpp_trace import capture_cpp
root = pathlib.Path(__file__).parent
out = root / "frontend" / "public" / "examples"
for src in sorted((root / "backend" / "cpp_examples").glob("*.cpp")):
    r = capture_cpp(src.read_text(), "", 5.0, 500)
    name = "cpp_" + src.stem + ".trace.json"
    (out / name).write_text(json.dumps(r, indent=1))
    print(name, r["status"], len(r["events"]), "events")
