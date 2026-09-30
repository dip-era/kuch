"""Load only the trusted, reusable Python definitions from our checked-in notebook."""

import ast
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "new-claude-sih-v2.ipynb"


def sources():
    return ["".join(cell["source"]) for cell in json.loads(NOTEBOOK.read_text())["cells"]
            if cell["cell_type"] == "code"]


def load_grid():
    package_name = "_dashboard_grid_v2"
    if package_name in sys.modules:
        return sys.modules[f"{package_name}.reference"]
    package = types.ModuleType(package_name)
    package.__path__ = []
    sys.modules[package_name] = package
    for name in ("config", "reference"):
        source = next(s for s in sources()
                      if s.startswith(f"%%writefile /kaggle/working/grid_engine_v2/{name}.py\n"))
        module = types.ModuleType(f"{package_name}.{name}")
        module.__package__ = package_name
        sys.modules[module.__name__] = module
        setattr(package, name, module)
        exec(compile(source.split("\n", 1)[1], f"{NOTEBOOK.name}:{name}", "exec"), module.__dict__)
    return package.reference


def load_projection(namespace):
    source = next(s for s in sources() if "def project_to_range_image(" in s)
    tree = ast.parse(source)
    function = next(node for node in tree.body
                    if isinstance(node, ast.FunctionDef) and node.name == "project_to_range_image")
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(NOTEBOOK), "exec"), namespace)
    return namespace["project_to_range_image"]
